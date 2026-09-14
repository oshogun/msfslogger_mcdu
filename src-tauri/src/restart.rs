use std::{collections::VecDeque, time::{Duration, Instant}};

pub const RESTART_DELAY: Duration = Duration::from_millis(2000);
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(2000);

#[derive(Default)]
pub struct RestartBudget { attempts: VecDeque<Instant> }

impl RestartBudget {
    // Unexpected exits permit at most five restarts in a rolling 60-second
    // window, with a fixed two-second delay. Exhaustion requires manual RESTART.
    pub fn reserve(&mut self, now: Instant) -> Option<usize> {
        while self.attempts.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
            self.attempts.pop_front();
        }
        if self.attempts.len() == 5 { return None; }
        self.attempts.push_back(now);
        Some(5 - self.attempts.len())
    }
    pub fn reset(&mut self) { self.attempts.clear(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sixth_restart_is_blocked_until_rolling_window_expires() {
        let now = Instant::now();
        let mut budget = RestartBudget::default();
        for n in 0..5 { assert_eq!(budget.reserve(now + RESTART_DELAY * n), Some(4 - n as usize)); }
        assert_eq!(budget.reserve(now + Duration::from_secs(59)), None);
        assert_eq!(budget.reserve(now + Duration::from_secs(60)), Some(0));
        budget.reset();
        assert_eq!(budget.reserve(now + Duration::from_secs(60)), Some(4));
    }
}
