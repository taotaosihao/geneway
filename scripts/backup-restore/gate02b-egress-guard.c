#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

static int receipt_fd = -1;
static dev_t receipt_device = 0;
static ino_t receipt_inode = 0;
static __thread int inside_guard = 0;
static __thread int authorized_connection = 0;
static pid_t identity_pid = -1;
static char identity_start_ticks[64] = "unknown";
static void install_browser_kernel_guard(void);

static int browser_guard_required(void) {
  const char *required = getenv("GENEWAY_GATE02B_BROWSER_EGRESS_GUARD");
  return required != NULL && strcmp(required, "required") == 0;
}

static const char *browser_policy_hash(void) {
  const char *hash = getenv("GENEWAY_GATE02B_BROWSER_POLICY_HASH");
  if (hash == NULL || strlen(hash) != 64) return NULL;
  for (const unsigned char *cursor = (const unsigned char *) hash; *cursor != '\0'; cursor += 1) {
    if (!((*cursor >= '0' && *cursor <= '9') || (*cursor >= 'a' && *cursor <= 'f'))) return NULL;
  }
  return hash;
}

static void write_receipt(const char *format, ...) {
  if (inside_guard) return;
  if (receipt_fd < 0) {
    if (browser_guard_required()) _exit(126);
    return;
  }
  inside_guard = 1;
  char line[512];
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(line, sizeof(line), format, arguments);
  va_end(arguments);
  if (length > 0 && (size_t) length < sizeof(line)) {
    size_t bounded = (size_t) length < sizeof(line) ? (size_t) length : sizeof(line) - 1;
    if (browser_guard_required()) {
      struct stat receipt_stat;
      if (fstat(receipt_fd, &receipt_stat) < 0 || !S_ISREG(receipt_stat.st_mode)
        || receipt_stat.st_dev != receipt_device || receipt_stat.st_ino != receipt_inode
        || (receipt_stat.st_mode & 0777) != 0600 || receipt_stat.st_uid != getuid() || receipt_stat.st_nlink != 1) {
        _exit(126);
      }
    }
    ssize_t written = write(receipt_fd, line, bounded);
    if (written != (ssize_t) bounded) {
      receipt_fd = -1;
      if (browser_guard_required()) _exit(126);
    }
  } else if (browser_guard_required()) {
    _exit(126);
  }
  inside_guard = 0;
}

static void read_process_start_ticks(char *target, size_t target_size) {
  (void) snprintf(target, target_size, "unknown");
  int stat_fd = open("/proc/self/stat", O_RDONLY | O_CLOEXEC);
  if (stat_fd < 0) return;
  char stat_line[1024];
  ssize_t count = read(stat_fd, stat_line, sizeof(stat_line) - 1);
  (void) close(stat_fd);
  if (count <= 0) return;
  stat_line[count] = '\0';
  char *fields = strrchr(stat_line, ')');
  if (fields == NULL) return;
  fields += 2;
  char *save = NULL;
  char *token = strtok_r(fields, " ", &save);
  for (int index = 0; token != NULL && index <= 19; index += 1, token = strtok_r(NULL, " ", &save)) {
    if (index == 19) (void) snprintf(target, target_size, "%s", token);
  }
}

static void ensure_browser_process_identity(void) {
  if (!browser_guard_required() || identity_pid == getpid()) return;
  pid_t inherited_from = identity_pid;
  char inherited_start_ticks[64];
  (void) snprintf(inherited_start_ticks, sizeof(inherited_start_ticks), "%s", identity_start_ticks);
  identity_pid = getpid();
  read_process_start_ticks(identity_start_ticks, sizeof(identity_start_ticks));
  authorized_connection = 0;
  write_receipt("BROWSER_CHILD pid=%ld ppid=%ld startTicks=%s inheritedFrom=%ld inheritedFromStartTicks=%s kernel=inherited policyHash=%s\n",
    (long) identity_pid, (long) getppid(), identity_start_ticks, (long) inherited_from, inherited_start_ticks,
    browser_policy_hash() == NULL ? "invalid" : browser_policy_hash());
}

static void write_network_receipt(int socket_fd, const char *format, ...) {
  char detail[384];
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(detail, sizeof(detail), format, arguments);
  va_end(arguments);
  if (length <= 0) return;
  if (!browser_guard_required()) {
    write_receipt("%s", detail);
    return;
  }
  ensure_browser_process_identity();
  write_receipt("BROWSER_EVENT pid=%ld ppid=%ld startTicks=%s policyHash=%s fd=%d %s",
    (long) identity_pid, (long) getppid(), identity_start_ticks,
    browser_policy_hash() == NULL ? "invalid" : browser_policy_hash(), socket_fd, detail);
}

__attribute__((constructor)) static void initialize_guard(void) {
  const char *receipt = getenv("GENEWAY_GATE02B_EGRESS_RECEIPT");
  if (receipt == NULL || receipt[0] == '\0') {
    if (browser_guard_required()) _exit(126);
    return;
  }
  int receipt_flags = O_WRONLY | O_APPEND | O_CLOEXEC;
  if (browser_guard_required()) receipt_flags |= O_NOFOLLOW;
  else receipt_flags |= O_CREAT;
  receipt_fd = open(receipt, receipt_flags, 0600);
  if (browser_guard_required()) {
    struct stat receipt_stat;
    if (receipt_fd < 0 || fstat(receipt_fd, &receipt_stat) < 0 || !S_ISREG(receipt_stat.st_mode)
      || (receipt_stat.st_mode & 0777) != 0600 || receipt_stat.st_uid != getuid() || receipt_stat.st_nlink != 1) {
      _exit(126);
    }
    receipt_device = receipt_stat.st_dev;
    receipt_inode = receipt_stat.st_ino;
  }
  char hostname[256] = "unknown";
  (void) gethostname(hostname, sizeof(hostname) - 1);
  identity_pid = getpid();
  read_process_start_ticks(identity_start_ticks, sizeof(identity_start_ticks));
  write_receipt("START pid=%ld startTicks=%s hostname=%s\n", (long) identity_pid, identity_start_ticks, hostname);
  install_browser_kernel_guard();
}

static int allowed_port(unsigned int port) {
  const char *allowed = getenv("GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS");
  if (allowed == NULL) return 0;
  char expected[16];
  (void) snprintf(expected, sizeof(expected), ",%u,", port);
  char wrapped[1024];
  (void) snprintf(wrapped, sizeof(wrapped), ",%s,", allowed);
  return strstr(wrapped, expected) != NULL;
}

static int parse_canonical_decimal(const char *text, unsigned long long maximum, unsigned long long *value) {
  if (text == NULL || text[0] < '1' || text[0] > '9') return 0;
  unsigned long long parsed = 0;
  for (const unsigned char *cursor = (const unsigned char *) text; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return 0;
    unsigned int digit = (unsigned int) (*cursor - '0');
    if (parsed > (maximum - digit) / 10ULL) return 0;
    parsed = parsed * 10ULL + digit;
  }
  *value = parsed;
  return 1;
}

static int install_browser_landlock(void) {
  int abi = (int) syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 4) return -1;
  struct landlock_ruleset_attr ruleset = { .handled_access_net = LANDLOCK_ACCESS_NET_CONNECT_TCP };
  int ruleset_fd = (int) syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) return -1;
  const char *allowed = getenv("GENEWAY_GATE02B_EGRESS_ALLOWED_PORTS");
  if (allowed == NULL || allowed[0] == '\0' || strlen(allowed) >= 1024) {
    (void) close(ruleset_fd);
    errno = EINVAL;
    return -1;
  }
  char ports[1024];
  (void) snprintf(ports, sizeof(ports), "%s", allowed);
  int rule_count = 0;
  char *save = NULL;
  for (char *token = strtok_r(ports, ",", &save); token != NULL; token = strtok_r(NULL, ",", &save)) {
    unsigned long long port = 0;
    if (!parse_canonical_decimal(token, 65535ULL, &port)) {
      (void) close(ruleset_fd);
      errno = EINVAL;
      return -1;
    }
    struct landlock_net_port_attr rule = {
      .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
      .port = port,
    };
    if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_NET_PORT, &rule, 0) < 0) {
      (void) close(ruleset_fd);
      return -1;
    }
    rule_count += 1;
  }
  if (rule_count == 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0
    || syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) {
    (void) close(ruleset_fd);
    return -1;
  }
  (void) close(ruleset_fd);
  return abi;
}

static int install_browser_udp_seccomp(void) {
#if defined(__x86_64__)
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 10),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0xf),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_TCP, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short) (sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  return (int) syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
#else
  errno = ENOTSUP;
  return -1;
#endif
}

static void install_browser_kernel_guard(void) {
  if (!browser_guard_required()) return;
  struct stat executable_stat;
  struct stat guard_stat;
  const char *guard_path = getenv("LD_PRELOAD");
  if (browser_policy_hash() == NULL) {
    write_receipt("BROWSER_KERNEL pid=%ld ppid=%ld startTicks=%s status=FAILED reason=policy-hash\n",
      (long) identity_pid, (long) getppid(), identity_start_ticks);
    _exit(126);
  }
  if (guard_path == NULL || guard_path[0] != '/' || strchr(guard_path, ':') != NULL
    || stat("/proc/self/exe", &executable_stat) < 0 || stat(guard_path, &guard_stat) < 0
    || !S_ISREG(executable_stat.st_mode) || !S_ISREG(guard_stat.st_mode)) {
    write_receipt("BROWSER_KERNEL pid=%ld ppid=%ld startTicks=%s policyHash=%s status=FAILED reason=identity\n",
      (long) identity_pid, (long) getppid(), identity_start_ticks, browser_policy_hash());
    _exit(126);
  }
  int landlock_abi = install_browser_landlock();
  if (landlock_abi < 4 || install_browser_udp_seccomp() < 0) {
    write_receipt("BROWSER_KERNEL pid=%ld ppid=%ld startTicks=%s policyHash=%s status=FAILED errno=%d\n",
      (long) identity_pid, (long) getppid(), identity_start_ticks, browser_policy_hash(), errno);
    _exit(126);
  }
  write_receipt("BROWSER_KERNEL pid=%ld ppid=%ld startTicks=%s policyHash=%s exeDev=%llu exeIno=%llu guardDev=%llu guardIno=%llu status=ENFORCED landlockAbi=%d tcp=allowlisted udp=blocked\n",
    (long) identity_pid, (long) getppid(), identity_start_ticks, browser_policy_hash(),
    (unsigned long long) executable_stat.st_dev, (unsigned long long) executable_stat.st_ino,
    (unsigned long long) guard_stat.st_dev, (unsigned long long) guard_stat.st_ino, landlock_abi);
}

static int allowed_unix_path(const char *allowed, const char *path, size_t path_length) {
  if (allowed == NULL) return 0;
  const char prefix[] = "tsx-pipe:";
  if (strncmp(allowed, prefix, sizeof(prefix) - 1) != 0) {
    return strlen(allowed) == path_length && memcmp(path, allowed, path_length) == 0;
  }
  const char *directory = allowed + sizeof(prefix) - 1;
  size_t directory_length = strlen(directory);
  if (path_length <= directory_length + 6 || memcmp(path, directory, directory_length) != 0
    || path[directory_length] != '/') return 0;
  size_t cursor = directory_length + 1;
  size_t suffix = path_length - 5;
  if (cursor >= suffix || memcmp(path + suffix, ".pipe", 5) != 0) return 0;
  for (; cursor < suffix; cursor += 1) if (path[cursor] < '0' || path[cursor] > '9') return 0;
  return 1;
}

static int allowed_proxy_target(const char *rendered, unsigned int port) {
  const char *address = getenv("GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_IPV4");
  const char *port_text = getenv("GENEWAY_GATE02B_EGRESS_ALLOWED_TARGET_PORT");
  if (address == NULL || port_text == NULL || strcmp(address, rendered) != 0) return 0;
  unsigned long long expected = 0;
  return parse_canonical_decimal(port_text, 65535ULL, &expected) && expected == port;
}

static int authorize(int socket_fd, const char *call, const struct sockaddr *address, socklen_t length) {
  if (address == NULL || length < sizeof(sa_family_t)) {
    if (browser_guard_required() && strcmp(call, "connect") != 0) {
      write_network_receipt(socket_fd, "ALLOW call=%s family=CONNECTED reason=kernel-guarded\n", call);
      return 1;
    }
    if (authorized_connection && strcmp(call, "connect") != 0) {
      write_network_receipt(socket_fd, "ALLOW call=%s family=CONNECTED\n", call);
      return 1;
    }
    write_network_receipt(socket_fd, "DENY call=%s family=CONNECTED\n", call);
    errno = EPERM;
    return 0;
  }
  if (address->sa_family == AF_UNIX) {
    const struct sockaddr_un *unix_address = (const struct sockaddr_un *) address;
    const char *allowed = getenv("GENEWAY_GATE02B_EGRESS_ALLOWED_UNIX");
    size_t offset = offsetof(struct sockaddr_un, sun_path);
    size_t path_length = length > offset ? (size_t) length - offset : 0;
    const void *terminator = path_length > 0 ? memchr(unix_address->sun_path, '\0', path_length) : NULL;
    size_t actual_length = terminator == NULL ? path_length : (size_t) ((const char *) terminator - unix_address->sun_path);
    if (allowed != NULL && path_length > 0 && unix_address->sun_path[0] != '\0'
      && allowed_unix_path(allowed, unix_address->sun_path, actual_length)) {
      write_network_receipt(socket_fd, "ALLOW call=%s family=AF_UNIX path=%.*s\n", call, (int) actual_length, unix_address->sun_path);
      return 1;
    }
    if (path_length > 0 && unix_address->sun_path[0] != '\0') {
      write_network_receipt(socket_fd, "DENY call=%s family=AF_UNIX path=%.*s\n", call, (int) actual_length, unix_address->sun_path);
    } else write_network_receipt(socket_fd, "DENY call=%s family=AF_UNIX path=abstract-or-invalid\n", call);
    errno = EPERM;
    return 0;
  }
  char rendered[INET6_ADDRSTRLEN] = "unknown";
  unsigned int port = 0;
  int loopback = 0;
  if (address->sa_family == AF_INET && length >= sizeof(struct sockaddr_in)) {
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *) address;
    (void) inet_ntop(AF_INET, &ipv4->sin_addr, rendered, sizeof(rendered));
    port = ntohs(ipv4->sin_port);
    loopback = ntohl(ipv4->sin_addr.s_addr) == 0x7f000001U;
  } else if (address->sa_family == AF_INET6 && length >= sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *) address;
    (void) inet_ntop(AF_INET6, &ipv6->sin6_addr, rendered, sizeof(rendered));
    port = ntohs(ipv6->sin6_port);
    loopback = IN6_IS_ADDR_LOOPBACK(&ipv6->sin6_addr);
    if (IN6_IS_ADDR_V4MAPPED(&ipv6->sin6_addr)) {
      const unsigned char *bytes = ipv6->sin6_addr.s6_addr;
      loopback = bytes[12] == 127 && bytes[13] == 0 && bytes[14] == 0 && bytes[15] == 1;
    }
  }
  if (strcmp(call, "connect") == 0 && address->sa_family == AF_INET && allowed_proxy_target(rendered, port)) {
    const char *attempt = getenv("GENEWAY_GATE02B_EGRESS_ATTEMPT_ID");
    unsigned long long attempt_number = 0;
    if (parse_canonical_decimal(attempt, 9007199254740991ULL, &attempt_number)) {
      write_network_receipt(socket_fd, "ALLOW attempt=%s call=connect family=2 address=%s port=%u\n", attempt, rendered, port);
      return 1;
    }
    write_network_receipt(socket_fd, "DENY call=connect family=2 address=%s port=%u reason=missing-attempt\n", rendered, port);
    errno = EPERM;
    return 0;
  }
  if (loopback && allowed_port(port)) {
    write_network_receipt(socket_fd, "ALLOW call=%s family=%d address=%s port=%u\n", call, address->sa_family, rendered, port);
    return 1;
  }
  write_network_receipt(socket_fd, "DENY call=%s family=%d address=%s port=%u\n", call, address->sa_family, rendered, port);
  errno = EPERM;
  return 0;
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
  static int (*real_connect)(int, const struct sockaddr *, socklen_t);
  if (real_connect == NULL) real_connect = dlsym(RTLD_NEXT, "connect");
  if (real_connect == NULL) { write_network_receipt(socket_fd, "DENY call=connect reason=dlsym\n"); errno = ENOSYS; return -1; }
  if (!authorize(socket_fd, "connect", address, length)) return -1;
  int result = real_connect(socket_fd, address, length);
  if (result == 0) authorized_connection = 1;
  return result;
}

ssize_t sendto(int socket_fd, const void *buffer, size_t size, int flags,
  const struct sockaddr *address, socklen_t length) {
  static ssize_t (*real_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
  if (real_sendto == NULL) real_sendto = dlsym(RTLD_NEXT, "sendto");
  if (real_sendto == NULL) { write_network_receipt(socket_fd, "DENY call=sendto reason=dlsym\n"); errno = ENOSYS; return -1; }
  if (!authorize(socket_fd, "sendto", address, length)) return -1;
  return real_sendto(socket_fd, buffer, size, flags, address, length);
}

ssize_t sendmsg(int socket_fd, const struct msghdr *message, int flags) {
  static ssize_t (*real_sendmsg)(int, const struct msghdr *, int);
  if (real_sendmsg == NULL) real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
  if (real_sendmsg == NULL) { write_network_receipt(socket_fd, "DENY call=sendmsg reason=dlsym\n"); errno = ENOSYS; return -1; }
  const struct sockaddr *address = message == NULL ? NULL : (const struct sockaddr *) message->msg_name;
  socklen_t length = message == NULL ? 0 : message->msg_namelen;
  if (!authorize(socket_fd, "sendmsg", address, length)) return -1;
  return real_sendmsg(socket_fd, message, flags);
}

int sendmmsg(int socket_fd, struct mmsghdr *messages, unsigned int count, int flags) {
  static int (*real_sendmmsg)(int, struct mmsghdr *, unsigned int, int);
  if (real_sendmmsg == NULL) real_sendmmsg = dlsym(RTLD_NEXT, "sendmmsg");
  if (real_sendmmsg == NULL) { write_network_receipt(socket_fd, "DENY call=sendmmsg reason=dlsym\n"); errno = ENOSYS; return -1; }
  for (unsigned int index = 0; index < count; index += 1) {
    const struct sockaddr *address = (const struct sockaddr *) messages[index].msg_hdr.msg_name;
    socklen_t length = messages[index].msg_hdr.msg_namelen;
    if (!authorize(socket_fd, "sendmmsg", address, length)) return -1;
  }
  return real_sendmmsg(socket_fd, messages, count, flags);
}
