//! Terminal formatting: tables, timestamps and relative times.
//!
//! Deliberately dependency free. Tables are plain ASCII so they render in every
//! terminal and paste cleanly into an issue; timestamps are UTC so two people
//! looking at the same account see the same value.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, saturating rather than panicking if the
/// clock is before 1970.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// A minimal left-aligned table with a header row.
pub struct Table {
    headers: Vec<&'static str>,
    rows: Vec<Vec<String>>,
}

impl Table {
    pub fn new(headers: &[&'static str]) -> Self {
        Self { headers: headers.to_vec(), rows: Vec::new() }
    }

    pub fn push(&mut self, row: Vec<String>) {
        debug_assert_eq!(row.len(), self.headers.len());
        self.rows.push(row);
    }

    pub fn render(&self) -> String {
        let mut widths: Vec<usize> = self.headers.iter().map(|header| header.chars().count()).collect();
        for row in &self.rows {
            for (index, cell) in row.iter().enumerate() {
                widths[index] = widths[index].max(cell.chars().count());
            }
        }
        let mut output = String::new();
        output.push_str(&render_row(&self.headers.iter().map(|header| header.to_uppercase()).collect::<Vec<_>>(), &widths));
        output.push('\n');
        for row in &self.rows {
            output.push_str(&render_row(row, &widths));
            output.push('\n');
        }
        output
    }
}

fn render_row(cells: &[String], widths: &[usize]) -> String {
    let mut line = String::new();
    for (index, cell) in cells.iter().enumerate() {
        if index > 0 {
            line.push_str("  ");
        }
        line.push_str(cell);
        if index + 1 < cells.len() {
            let padding = widths[index].saturating_sub(cell.chars().count());
            line.push_str(&" ".repeat(padding));
        }
    }
    line.trim_end().to_string()
}

/// Shortens a value to `max` characters, marking the cut with an ellipsis.
pub fn truncate(value: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut short: String = value.chars().take(max - 1).collect();
    short.push('…');
    short
}

/// Formats Unix milliseconds as `YYYY-MM-DD HH:MM` in UTC.
pub fn utc(milliseconds: u64) -> String {
    let seconds = (milliseconds / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let within_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        within_day / 3_600,
        (within_day % 3_600) / 60
    )
}

/// A friendly age, falling back to the absolute date once it stops being useful.
pub fn relative(milliseconds: u64, now: u64) -> String {
    if milliseconds == 0 {
        return "never".to_string();
    }
    let seconds = now.saturating_sub(milliseconds) / 1000;
    match seconds {
        0..=59 => "just now".to_string(),
        60..=3_599 => format!("{}m ago", seconds / 60),
        3_600..=86_399 => format!("{}h ago", seconds / 3_600),
        86_400..=2_591_999 => format!("{}d ago", seconds / 86_400),
        _ => utc(milliseconds),
    }
}

/// "in 58 minutes" / "expired 2 minutes ago", for a deadline.
pub fn remaining(deadline: u64, now: u64) -> String {
    if deadline == 0 {
        return "unknown".to_string();
    }
    if deadline <= now {
        return format!("expired {}", relative(deadline, now));
    }
    let seconds = (deadline - now) / 1000;
    if seconds < 60 {
        format!("in {seconds} seconds")
    } else if seconds < 3_600 {
        plural(seconds / 60, "minute")
    } else if seconds < 86_400 {
        plural(seconds / 3_600, "hour")
    } else {
        plural(seconds / 86_400, "day")
    }
}

fn plural(value: u64, unit: &str) -> String {
    if value == 1 {
        format!("in 1 {unit}")
    } else {
        format!("in {value} {unit}s")
    }
}

/// Howard Hinnant's civil-from-days algorithm: days since 1970-01-01 to a
/// proleptic Gregorian date, without pulling in a calendar crate.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants_in_utc() {
        assert_eq!(utc(0), "1970-01-01 00:00");
        assert_eq!(utc(86_400_000), "1970-01-02 00:00");
        assert_eq!(utc(1_700_000_000_000), "2023-11-14 22:13");
        assert_eq!(utc(1_735_000_000_000), "2024-12-24 00:26");
        // A leap day, which the naive 365-day path would get wrong.
        assert_eq!(utc(1_709_164_800_000), "2024-02-29 00:00");
    }

    #[test]
    fn describes_ages_and_deadlines() {
        let now = 1_700_000_000_000;
        assert_eq!(relative(0, now), "never");
        assert_eq!(relative(now - 5_000, now), "just now");
        assert_eq!(relative(now - 120_000, now), "2m ago");
        assert_eq!(relative(now - 7_200_000, now), "2h ago");
        assert_eq!(relative(now - 172_800_000, now), "2d ago");
        assert_eq!(remaining(now + 59_000, now), "in 59 seconds");
        assert_eq!(remaining(now + 3_600_000, now), "in 1 hour");
        assert_eq!(remaining(now + 7_200_000, now), "in 2 hours");
        assert!(remaining(now - 60_000, now).starts_with("expired"));
    }

    #[test]
    fn renders_and_truncates_tables() {
        let mut table = Table::new(&["ID", "NAME"]);
        table.push(vec!["abc".into(), "Pixel 9 Pro".into()]);
        table.push(vec!["def".into(), "Chrome".into()]);
        let rendered = table.render();
        assert!(rendered.starts_with("ID   NAME"));
        assert!(rendered.contains("abc  Pixel 9 Pro"));
        assert_eq!(truncate("0123456789abcdef", 8), "0123456…");
        assert_eq!(truncate("short", 8), "short");
        assert_eq!(truncate("anything", 0), "");
    }
}
