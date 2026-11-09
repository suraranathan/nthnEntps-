#include <stdio.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void) {
    struct utsname info;
    if (uname(&info) != 0) return 2;
    printf("NTHN_NATIVE_OK arch=%s uid=%ld pid=%ld\n",
           info.machine, (long)getuid(), (long)getpid());
    fflush(stdout);
    return 0;
}
