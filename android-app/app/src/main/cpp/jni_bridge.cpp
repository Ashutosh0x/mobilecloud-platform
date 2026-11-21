// MobileCloud JNI bridge (master blueprint; APK build spec section 2).
//
// Library: libmobilecloud_native.so (loaded by MobileCloudApp).
//
// Surfaces:
//  1. Kernel version string (MobileCloudApp.getKernelVersion).
//  2. Unix PTY master/slave spawner for the inbuilt CloudShell
//     (NativePtyController): forkpty + non-blocking master fd.
//  3. sysfs SoC thermal reader for the supervisor governor loop
//     (CloudSupervisorService).
//
// StrongBox KeyStore operations stay on the Kotlin side: the TEE keymaster
// is a Binder service, not reachable from native code.

#include <jni.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <pty.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <android/log.h>

#define TAG "MobileCloudJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

// Non-blocking master so JNI reads return EAGAIN instead of blocking the
// caller's event loop.
int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

} // namespace

extern "C" {

// ---------------------------------------------------------------------------
// Kernel identity
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jstring JNICALL
Java_com_mobilecloud_MobileCloudApp_getKernelVersion(
        JNIEnv* env,
        jobject /* this */) {
    std::string version = "por-kernel-2026.1-aarch64";
    return env->NewStringUTF(version.c_str());
}

// ---------------------------------------------------------------------------
// PTY subsystem (com.mobilecloud.terminal.NativePtyController)
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeSpawnPty(
        JNIEnv *env, jclass, jint rows, jint cols,
        jstring shellPath, jstring envHome, jstring envPath) {
    const char *shell = env->GetStringUTFChars(shellPath, nullptr);
    const char *home = env->GetStringUTFChars(envHome, nullptr);
    const char *path = env->GetStringUTFChars(envPath, nullptr);

    struct winsize ws{};
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_col = static_cast<unsigned short>(cols);

    int master_fd = -1;
    pid_t child = forkpty(&master_fd, nullptr, nullptr, &ws);
    if (child < 0) {
        LOGE("forkpty failed: %s", strerror(errno));
        env->ReleaseStringUTFChars(shellPath, shell);
        env->ReleaseStringUTFChars(envHome, home);
        env->ReleaseStringUTFChars(envPath, path);
        return -errno;
    }

    if (child == 0) {
        // Child: sandboxed userland session. TERM/HOME/PATH only - no
        // Android app environment leaks into the shell.
        setenv("TERM", "xterm-256color", 1);
        setenv("HOME", home, 1);
        setenv("PATH", path, 1);
        unsetenv("ANDROID_DATA");
        unsetenv("ANDROID_ROOT");
        execl(shell, shell, "-l", nullptr);
        _exit(127); // exec failed
    }

    set_nonblocking(master_fd);
    LOGI("PTY spawned: master=%d child=%d shell=%s", master_fd, child, shell);

    env->ReleaseStringUTFChars(shellPath, shell);
    env->ReleaseStringUTFChars(envHome, home);
    env->ReleaseStringUTFChars(envPath, path);
    return master_fd;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeReadPty(
        JNIEnv *env, jclass, jint fd, jbyteArray buffer, jint maxBytes) {
    jbyte buf[4096];
    int to_read = maxBytes < 4096 ? maxBytes : 4096;
    ssize_t n = read(fd, buf, to_read);
    if (n < 0) {
        return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -errno;
    }
    if (n == 0) return -EIO; // EOF - slave closed
    env->SetByteArrayRegion(buffer, 0, n, buf);
    return static_cast<jint>(n);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeWritePty(
        JNIEnv *env, jclass, jint fd, jbyteArray buffer, jint length) {
    jbyte buf[4096];
    int to_write = length < 4096 ? length : 4096;
    env->GetByteArrayRegion(buffer, 0, to_write, buf);
    ssize_t n = write(fd, buf, to_write);
    return n < 0 ? -errno : static_cast<jint>(n);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeResizePty(
        JNIEnv *, jclass, jint fd, jint rows, jint cols) {
    struct winsize ws{};
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_col = static_cast<unsigned short>(cols);
    return ioctl(fd, TIOCSWINSZ, &ws) == 0 ? 0 : -errno;
}

extern "C" JNIEXPORT void JNICALL
Java_com_mobilecloud_terminal_NativePtyController_nativeClosePty(
        JNIEnv *, jclass, jint fd) {
    close(fd);
    int status;
    waitpid(-1, &status, WNOHANG); // best-effort reap
}

// ---------------------------------------------------------------------------
// Thermal governor feed (com.mobilecloud.service.CloudSupervisorService)
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jint JNICALL
Java_com_mobilecloud_service_CloudSupervisorService_nativeReadSocTempMilli(
        JNIEnv *, jclass) {
    int best = 31000; // emulated idle fallback when sysfs is unavailable
    for (int zone = 0; zone < 16; ++zone) {
        char path[96];
        snprintf(path, sizeof(path), "/sys/class/thermal/thermal_zone%d/temp", zone);
        FILE *f = fopen(path, "re");
        if (!f) continue;
        int milli = 0;
        if (fscanf(f, "%d", &milli) == 1 && milli > best && milli < 120000) {
            best = milli;
        }
        fclose(f);
    }
    return best;
}

} // extern "C"
