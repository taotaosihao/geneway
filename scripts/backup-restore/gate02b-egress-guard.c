#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

static int receipt_fd = -1;
static __thread int inside_guard = 0;
static __thread int authorized_connection = 0;

static void write_receipt(const char *format, ...) {
  if (receipt_fd < 0 || inside_guard) return;
  inside_guard = 1;
  char line[512];
  va_list arguments;
  va_start(arguments, format);
  int length = vsnprintf(line, sizeof(line), format, arguments);
  va_end(arguments);
  if (length > 0) {
    size_t bounded = (size_t) length < sizeof(line) ? (size_t) length : sizeof(line) - 1;
    ssize_t written = write(receipt_fd, line, bounded);
    if (written < 0) receipt_fd = -1;
  }
  inside_guard = 0;
}

__attribute__((constructor)) static void initialize_guard(void) {
  const char *receipt = getenv("GENEWAY_GATE02B_EGRESS_RECEIPT");
  if (receipt == NULL || receipt[0] == '\0') return;
  receipt_fd = open(receipt, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  char hostname[256] = "unknown";
  (void) gethostname(hostname, sizeof(hostname) - 1);
  char start_ticks[64] = "unknown";
  int stat_fd = open("/proc/self/stat", O_RDONLY | O_CLOEXEC);
  if (stat_fd >= 0) {
    char stat_line[1024];
    ssize_t count = read(stat_fd, stat_line, sizeof(stat_line) - 1);
    (void) close(stat_fd);
    if (count > 0) {
      stat_line[count] = '\0';
      char *fields = strrchr(stat_line, ')');
      if (fields != NULL) {
        fields += 2;
        char *save = NULL;
        char *token = strtok_r(fields, " ", &save);
        for (int index = 0; token != NULL && index <= 19; index += 1, token = strtok_r(NULL, " ", &save)) {
          if (index == 19) (void) snprintf(start_ticks, sizeof(start_ticks), "%s", token);
        }
      }
    }
  }
  write_receipt("START pid=%ld startTicks=%s hostname=%s\n", (long) getpid(), start_ticks, hostname);
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

static int authorize(const char *call, const struct sockaddr *address, socklen_t length) {
  if (address == NULL || length < sizeof(sa_family_t)) {
    if (authorized_connection && strcmp(call, "connect") != 0) {
      write_receipt("ALLOW call=%s family=CONNECTED\n", call);
      return 1;
    }
    write_receipt("DENY call=%s family=CONNECTED\n", call);
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
      write_receipt("ALLOW call=%s family=AF_UNIX path=%.*s\n", call, (int) actual_length, unix_address->sun_path);
      return 1;
    }
    if (path_length > 0 && unix_address->sun_path[0] != '\0') {
      write_receipt("DENY call=%s family=AF_UNIX path=%.*s\n", call, (int) actual_length, unix_address->sun_path);
    } else write_receipt("DENY call=%s family=AF_UNIX path=abstract-or-invalid\n", call);
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
      write_receipt("ALLOW attempt=%s call=connect family=2 address=%s port=%u\n", attempt, rendered, port);
      return 1;
    }
    write_receipt("DENY call=connect family=2 address=%s port=%u reason=missing-attempt\n", rendered, port);
    errno = EPERM;
    return 0;
  }
  if (loopback && allowed_port(port)) {
    write_receipt("ALLOW call=%s family=%d address=%s port=%u\n", call, address->sa_family, rendered, port);
    return 1;
  }
  write_receipt("DENY call=%s family=%d address=%s port=%u\n", call, address->sa_family, rendered, port);
  errno = EPERM;
  return 0;
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
  static int (*real_connect)(int, const struct sockaddr *, socklen_t);
  if (real_connect == NULL) real_connect = dlsym(RTLD_NEXT, "connect");
  if (real_connect == NULL) { write_receipt("DENY call=connect reason=dlsym\n"); errno = ENOSYS; return -1; }
  if (!authorize("connect", address, length)) return -1;
  int result = real_connect(socket_fd, address, length);
  if (result == 0) authorized_connection = 1;
  return result;
}

ssize_t sendto(int socket_fd, const void *buffer, size_t size, int flags,
  const struct sockaddr *address, socklen_t length) {
  static ssize_t (*real_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
  if (real_sendto == NULL) real_sendto = dlsym(RTLD_NEXT, "sendto");
  if (real_sendto == NULL) { write_receipt("DENY call=sendto reason=dlsym\n"); errno = ENOSYS; return -1; }
  if (!authorize("sendto", address, length)) return -1;
  return real_sendto(socket_fd, buffer, size, flags, address, length);
}

ssize_t sendmsg(int socket_fd, const struct msghdr *message, int flags) {
  static ssize_t (*real_sendmsg)(int, const struct msghdr *, int);
  if (real_sendmsg == NULL) real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
  if (real_sendmsg == NULL) { write_receipt("DENY call=sendmsg reason=dlsym\n"); errno = ENOSYS; return -1; }
  const struct sockaddr *address = message == NULL ? NULL : (const struct sockaddr *) message->msg_name;
  socklen_t length = message == NULL ? 0 : message->msg_namelen;
  if (!authorize("sendmsg", address, length)) return -1;
  return real_sendmsg(socket_fd, message, flags);
}

int sendmmsg(int socket_fd, struct mmsghdr *messages, unsigned int count, int flags) {
  static int (*real_sendmmsg)(int, struct mmsghdr *, unsigned int, int);
  if (real_sendmmsg == NULL) real_sendmmsg = dlsym(RTLD_NEXT, "sendmmsg");
  if (real_sendmmsg == NULL) { write_receipt("DENY call=sendmmsg reason=dlsym\n"); errno = ENOSYS; return -1; }
  for (unsigned int index = 0; index < count; index += 1) {
    const struct sockaddr *address = (const struct sockaddr *) messages[index].msg_hdr.msg_name;
    socklen_t length = messages[index].msg_hdr.msg_namelen;
    if (!authorize("sendmmsg", address, length)) return -1;
  }
  return real_sendmmsg(socket_fd, messages, count, flags);
}
