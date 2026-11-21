cmake_minimum_required(VERSION 3.22.1)

project("mobilecloud_native")

add_library(
    mobilecloud_native
    SHARED
    jni_bridge.cpp
)

target_link_libraries(
    mobilecloud_native
    android
    log
)
