use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Word(String),
    Str(String),
    Op(&'static str),
    LParen,
    RParen,
}

const OPS: [&str; 7] = ["<=", ">=", "!=", "=", "<", ">", "~"];

fn is_word_char(c: char) -> bool {
    !c.is_whitespace() && !matches!(c, '(' | ')' | '=' | '!' | '<' | '>' | '~' | '"')
}

pub fn tokenize(input: &str) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '(' {
            tokens.push(Token::LParen);
            i += 1;
            continue;
        }
        if c == ')' {
            tokens.push(Token::RParen);
            i += 1;
            continue;
        }
        if c == '"' {
            let mut s = String::new();
            i += 1;
            loop {
                match chars.get(i) {
                    None => return Err(Error::Query("unterminated string".into())),
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some('\\') if chars.get(i + 1).is_some() => {
                        s.push(chars[i + 1]);
                        i += 2;
                    }
                    Some(ch) => {
                        s.push(*ch);
                        i += 1;
                    }
                }
            }
            tokens.push(Token::Str(s));
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 2)].iter().collect();
        if let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) {
            tokens.push(Token::Op(op));
            i += op.len();
            continue;
        }
        if c == '!' {
            return Err(Error::Query("unexpected '!'".into()));
        }
        let start = i;
        while i < chars.len() && is_word_char(chars[i]) {
            i += 1;
        }
        tokens.push(Token::Word(chars[start..i].iter().collect()));
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_operators_and_words() {
        let t = tokenize("amount>=12.50 and payee~\"Big \\\"Co\\\"\"").unwrap();
        assert_eq!(
            t,
            vec![
                Token::Word("amount".into()),
                Token::Op(">="),
                Token::Word("12.50".into()),
                Token::Word("and".into()),
                Token::Word("payee".into()),
                Token::Op("~"),
                Token::Str("Big \"Co\"".into()),
            ]
        );
    }
}
