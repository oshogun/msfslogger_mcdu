#include "bridge_protocol.h"

#if !defined(MSFSLOGGER_HOST_TEST)

#include <MSFS/MSFS.h>
#include <MSFS/Legacy/gauges.h>

namespace {

ID heartbeat_id = -1;
double last_update_seconds = 0.0;
bool has_last_update = false;
std::uint64_t heartbeat = 0;
std::uint64_t remainder_ms = 0;
double sub_millisecond_remainder = 0.0;

double absolute_time_seconds() noexcept {
    double seconds = 0.0;
    execute_calculator_code("(E:ABSOLUTE TIME, seconds)", &seconds, nullptr, nullptr);
    return seconds;
}

}  // namespace

extern "C" MSFS_CALLBACK void module_init() {
    heartbeat_id = register_named_variable(msfslogger::bridge::kHeartbeatLVar);
    heartbeat = 0;
    remainder_ms = 0;
    sub_millisecond_remainder = 0.0;
    has_last_update = false;
    set_named_variable_value(heartbeat_id, 0.0);
}

extern "C" MSFS_CALLBACK void module_update() {
    const double now_seconds = absolute_time_seconds();
    if (!has_last_update) {
        last_update_seconds = now_seconds;
        has_last_update = true;
        return;
    }

    const double elapsed_seconds = now_seconds - last_update_seconds;
    last_update_seconds = now_seconds;
    if (elapsed_seconds <= 0.0) {
        return;
    }

    const double elapsed_with_remainder =
        elapsed_seconds * 1000.0 + sub_millisecond_remainder;
    const auto elapsed_ms = static_cast<std::uint64_t>(elapsed_with_remainder);
    sub_millisecond_remainder = elapsed_with_remainder - static_cast<double>(elapsed_ms);
    const auto advanced =
        msfslogger::bridge::advance_heartbeat(heartbeat, elapsed_ms, remainder_ms);
    remainder_ms = advanced.remainder_ms;
    if (advanced.value != heartbeat) {
        heartbeat = advanced.value;
        set_named_variable_value(heartbeat_id, static_cast<double>(heartbeat));
    }
}

extern "C" MSFS_CALLBACK void module_deinit() {
    if (heartbeat_id >= 0) {
        unregister_all_named_vars();
        heartbeat_id = -1;
    }
    heartbeat = 0;
    remainder_ms = 0;
    sub_millisecond_remainder = 0.0;
    has_last_update = false;
}

#endif
