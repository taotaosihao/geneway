#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <linux/net.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static int parse_port(const char *text) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  return end != NULL && *end == '\0' && value > 0 && value <= 65535 ? (int) value : -1;
}

static int raw_connect_errno(int port) {
  int socket_fd = (int) syscall(SYS_socket, AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (socket_fd < 0) return errno;
  struct sockaddr_in address = {
    .sin_family = AF_INET,
    .sin_port = htons((unsigned short) port),
  };
  (void) inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  int result = (int) syscall(SYS_connect, socket_fd, &address, sizeof(address));
  int saved_errno = result == 0 ? 0 : errno;
  (void) close(socket_fd);
  return saved_errno;
}

static int raw_socket_errno(int domain, int type, int protocol) {
  errno = 0;
  int socket_fd = (int) syscall(SYS_socket, domain, type | SOCK_CLOEXEC, protocol);
  int saved_errno = socket_fd < 0 ? errno : 0;
  if (socket_fd >= 0) (void) close(socket_fd);
  return saved_errno;
}

int main(int argc, char **argv) {
  if (argc != 3) return 64;
  int allowed_port = parse_port(argv[1]);
  int forbidden_port = parse_port(argv[2]);
  if (allowed_port < 0 || forbidden_port < 0 || allowed_port == forbidden_port) return 65;
  int allowed_errno = raw_connect_errno(allowed_port);
  int forbidden_errno = raw_connect_errno(forbidden_port);
  int udp4_errno = raw_socket_errno(AF_INET, SOCK_DGRAM, 0);
  int udp6_errno = raw_socket_errno(AF_INET6, SOCK_DGRAM, 0);
  int raw_errno = raw_socket_errno(AF_INET, SOCK_RAW, 0);
  int seqpacket_errno = raw_socket_errno(AF_INET, SOCK_SEQPACKET, 0);
  int stream_udp_errno = raw_socket_errno(AF_INET, SOCK_STREAM, IPPROTO_UDP);
  printf("allowedErrno=%d forbiddenErrno=%d udp4Errno=%d udp6Errno=%d rawErrno=%d seqpacketErrno=%d streamUdpErrno=%d\n",
    allowed_errno, forbidden_errno, udp4_errno, udp6_errno, raw_errno, seqpacket_errno, stream_udp_errno);
  return (allowed_errno == EACCES || forbidden_errno != EACCES || udp4_errno != EPERM || udp6_errno != EPERM
    || raw_errno != EPERM || seqpacket_errno != EPERM || stream_udp_errno != EPERM) ? 1 : 0;
}
