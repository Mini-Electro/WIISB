//! Launch-argument parsing. Arguments are split into a `Vec<String>` and handed to the
//! OS as *separate* parameters — they are never concatenated into a shell command line.

const MAX_ARGS: usize = 32;
const MAX_LEN: usize = 2048;

pub fn parse_args(input: &str) -> Result<Vec<String>, String> {
    if input.len() > MAX_LEN {
        return Err("Launch arguments are too long.".into());
    }
    if input.chars().any(|c| c == '\0' || (c.is_control() && c != '\t')) {
        return Err("Launch arguments contain invalid control characters.".into());
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            '\\' if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if in_quotes {
        return Err("Launch arguments have an unmatched quote.".into());
    }
    if has_token {
        out.push(cur);
    }
    if out.len() > MAX_ARGS {
        return Err(format!("Too many launch arguments (maximum {MAX_ARGS})."));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_plain_and_quoted() {
        assert_eq!(parse_args("-windowed -w 1280").unwrap(), vec!["-windowed", "-w", "1280"]);
        assert_eq!(
            parse_args(r#"-save "C:\My Games\save 1" -x"#).unwrap(),
            vec!["-save", r"C:\My Games\save 1", "-x"]
        );
        assert!(parse_args("").unwrap().is_empty());
        assert!(parse_args("   ").unwrap().is_empty());
    }

    #[test]
    fn shell_metacharacters_stay_literal() {
        // No shell is involved, so these are just odd-looking arguments.
        assert_eq!(parse_args("& calc.exe | whoami").unwrap(), vec!["&", "calc.exe", "|", "whoami"]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_args("\"unterminated").is_err());
        assert!(parse_args("a\0b").is_err());
        assert!(parse_args(&"a ".repeat(40)).is_err());
    }
}
