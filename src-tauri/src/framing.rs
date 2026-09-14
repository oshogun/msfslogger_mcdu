use std::io::{self, BufRead};

pub const MAX_LINE_BYTES: usize = 65_536;

#[derive(Debug, PartialEq)]
pub enum Line { Text(String), Oversize, InvalidUtf8 }

// Consume an oversized line through its newline without ever retaining more
// than 64 KiB. read_line/read_until alone would allocate without a bound.
pub fn read_line(reader: &mut impl BufRead) -> io::Result<Option<Line>> {
    let mut line = Vec::new();
    let mut oversize = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(if oversize { Some(Line::Oversize) } else if line.is_empty() { None } else { Some(decode(line)) });
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(bytes.len());
        if !oversize {
            if line.len() + length > MAX_LINE_BYTES { line.clear(); oversize = true; }
            else { line.extend_from_slice(&bytes[..length]); }
        }
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(if oversize { Line::Oversize } else { decode(line) }));
        }
    }
}

fn decode(mut line: Vec<u8>) -> Line {
    if line.last() == Some(&b'\r') { line.pop(); }
    match String::from_utf8(line) { Ok(line) => Line::Text(line), Err(_) => Line::InvalidUtf8 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn oversized_line_is_dropped_and_next_line_survives() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES * 10];
        bytes.extend_from_slice(b"\nnext\r\nlast");
        let mut reader = BufReader::with_capacity(11, Cursor::new(bytes));
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::Oversize));
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::Text("next".into())));
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::Text("last".into())));
        assert_eq!(read_line(&mut reader).unwrap(), None);
    }

    #[test]
    fn accepts_exact_limit_and_recovers_after_invalid_utf8() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES];
        bytes.extend_from_slice(b"\n\xff\nok\n");
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::Text("x".repeat(MAX_LINE_BYTES))));
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::InvalidUtf8));
        assert_eq!(read_line(&mut reader).unwrap(), Some(Line::Text("ok".into())));
    }
}
