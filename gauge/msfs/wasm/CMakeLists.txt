cmake_minimum_required(VERSION 3.20)

project(MSFSLoggerBridge LANGUAGES CXX)

option(MSFSLOGGER_BUILD_WASM "Build the MSFS SDK WASM module" ON)
option(MSFSLOGGER_BUILD_TESTS "Build host-native tests" OFF)

set(MSFS_SDK_ROOT "" CACHE PATH "Microsoft Flight Simulator 2020 SDK root")

if(MSFSLOGGER_BUILD_TESTS)
    enable_testing()
    add_executable(heartbeat_test src/heartbeat.cpp tests/heartbeat_test.cpp)
    target_compile_features(heartbeat_test PRIVATE cxx_std_17)
    target_compile_definitions(heartbeat_test PRIVATE MSFSLOGGER_HOST_TEST=1)
    target_include_directories(heartbeat_test PRIVATE include)
    add_test(NAME heartbeat_test COMMAND heartbeat_test)
endif()

if(MSFSLOGGER_BUILD_WASM)
    if(NOT MSFS_SDK_ROOT)
        message(FATAL_ERROR "MSFS_SDK_ROOT must point to the installed MSFS 2020 SDK")
    endif()

    set(MSFS_WASM_ROOT "${MSFS_SDK_ROOT}/WASM")
    set(MSFS_CLANG_CL "${MSFS_WASM_ROOT}/llvm/bin/clang-cl.exe")
    set(MSFS_WASM_LD "${MSFS_WASM_ROOT}/llvm/bin/wasm-ld.exe")
    set(MSFS_WASI_SYSROOT "${MSFS_WASM_ROOT}/wasi-sysroot")

    foreach(required_path
            "${MSFS_CLANG_CL}"
            "${MSFS_WASM_LD}"
            "${MSFS_WASM_ROOT}/include"
            "${MSFS_WASI_SYSROOT}/include"
            "${MSFS_WASI_SYSROOT}/lib/wasm32-wasi")
        if(NOT EXISTS "${required_path}")
            message(FATAL_ERROR "Required MSFS SDK path is missing: ${required_path}")
        endif()
    endforeach()

    get_filename_component(MSFS_GAUGE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
    set(MSFS_WASM_OUTPUT_DIR "${MSFS_GAUGE_ROOT}/.build/wasm")
    set(MSFS_WASM_OBJECT "${CMAKE_CURRENT_BINARY_DIR}/heartbeat.wasm.obj")
    set(MSFS_WASM_OUTPUT "${MSFS_WASM_OUTPUT_DIR}/MSFSLoggerBridge.wasm")

    add_custom_command(
        OUTPUT "${MSFS_WASM_OBJECT}"
        COMMAND "${MSFS_CLANG_CL}"
            /nologo /c
            /clang:-std=c++17 /clang:-O2 /clang:-fms-extensions /D_MSFS_WASM
            /clang:--target=wasm32-wasi
            -I${MSFS_WASM_ROOT}/include
            -I${MSFS_WASI_SYSROOT}/include/c++/v1
            -I${MSFS_WASI_SYSROOT}/include
            -I${CMAKE_CURRENT_SOURCE_DIR}/include
            "${CMAKE_CURRENT_SOURCE_DIR}/src/heartbeat.cpp"
            -o "${MSFS_WASM_OBJECT}"
        DEPENDS src/heartbeat.cpp include/bridge_protocol.h
        VERBATIM)

    add_custom_command(
        OUTPUT "${MSFS_WASM_OUTPUT}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${MSFS_WASM_OUTPUT_DIR}"
        COMMAND "${MSFS_WASM_LD}"
            --no-entry
            --allow-undefined
            --export=module_init
            --export=module_update
            --export=module_deinit
            --export=malloc
            --export=free
            "${MSFS_WASM_OBJECT}"
            "${MSFS_WASI_SYSROOT}/lib/wasm32-wasi/libc++.a"
            "${MSFS_WASI_SYSROOT}/lib/wasm32-wasi/libc++abi.a"
            "${MSFS_WASI_SYSROOT}/lib/wasm32-wasi/libc.a"
            "${MSFS_WASI_SYSROOT}/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a"
            -o "${MSFS_WASM_OUTPUT}"
        DEPENDS "${MSFS_WASM_OBJECT}"
        VERBATIM)

    add_custom_target(MSFSLoggerBridge DEPENDS "${MSFS_WASM_OUTPUT}")
endif()
