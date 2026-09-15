#pragma once

#include <cstdint>

namespace msfslogger::bridge {

inline constexpr char kHeartbeatLVar[] = "L:MSFSLOGGER_BRIDGE_HEARTBEAT";
inline constexpr std::uint64_t kHeartbeatPeriodMs = 1000;

struct HeartbeatAdvance {
    std::uint64_t value;
    std::uint64_t remainder_ms;
};

constexpr HeartbeatAdvance advance_heartbeat(
    std::uint64_t current_value,
    std::uint64_t elapsed_ms,
    std::uint64_t prior_remainder_ms) noexcept {
    const auto accumulated_ms = prior_remainder_ms + elapsed_ms;
    return {
        current_value + accumulated_ms / kHeartbeatPeriodMs,
        accumulated_ms % kHeartbeatPeriodMs,
    };
}

}  // namespace msfslogger::bridge
