#include "bridge_protocol.h"

#include <cstdlib>
#include <iostream>

namespace {

void require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << "heartbeat_test: " << message << '\n';
        std::exit(EXIT_FAILURE);
    }
}

}  // namespace

int main() {
    using msfslogger::bridge::advance_heartbeat;

    auto state = advance_heartbeat(0, 999, 0);
    require(state.value == 0 && state.remainder_ms == 999,
            "a fractional period must not increment");

    state = advance_heartbeat(state.value, 1, state.remainder_ms);
    require(state.value == 1 && state.remainder_ms == 0,
            "exactly one second must increment once");

    state = advance_heartbeat(state.value, 3250, state.remainder_ms);
    require(state.value == 4 && state.remainder_ms == 250,
            "multiple elapsed seconds must catch up and retain the remainder");

    const auto next = advance_heartbeat(state.value, 750, state.remainder_ms);
    require(next.value == 5 && next.remainder_ms == 0,
            "retained fractions must complete the next one-second period");
    require(next.value > state.value, "heartbeat transitions must be monotonic");

    std::cout << "heartbeat_test: one-second cadence and monotonic catch-up verified\n";
    return EXIT_SUCCESS;
}
