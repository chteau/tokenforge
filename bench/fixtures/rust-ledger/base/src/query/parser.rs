use super::lexer::{tokenize, Token};
use super::{Expr, Field, Op, Value};
use crate::error::{Error, Result};
use crate::model::Kind;
use crate::util::Money;

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

/// Parse a filter expression.
pub fn parse(input: &str) -> Result<Expr> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(Error::Query("empty expression".into()));
    }
    let mut p = Parser { tokens, pos: 0 };
    let expr = p.or()?;
    if let Some(t) = p.peek() {
        return Err(Error::Query(format!("unexpected {}", describe(t))));
    }
    Ok(expr)
}

fn describe(t: &Token) -> String {
    match t {
        Token::Word(w) => format!("'{w}'"),
        Token::Str(s) => format!("\"{s}\""),
        Token::Op(o) => format!("'{o}'"),
        Token::LParen => "'('".into(),
        Token::RParen => "')'".into(),
    }
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn keyword(&mut self, kw: &str) -> bool {
        if let Some(Token::Word(w)) = self.peek() {
            if w.eq_ignore_ascii_case(kw) {
                self.pos += 1;
                return true;
            }
        }
        false
    }

    fn or(&mut self) -> Result<Expr> {
        let mut left = self.and()?;
        while self.keyword("or") {
            let right = self.and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr> {
        let mut left = self.unary()?;
        while self.keyword("and") {
            let right = self.unary()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr> {
        if self.keyword("not") {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        match self.next() {
            Some(Token::LParen) => {
                let e = self.or()?;
                match self.next() {
                    Some(Token::RParen) => Ok(e),
                    _ => Err(Error::Query("missing ')'".into())),
                }
            }
            Some(Token::Word(name)) => self.comparison(&name),
            Some(t) => Err(Error::Query(format!("unexpected {}", describe(&t)))),
            None => Err(Error::Query("unexpected end of expression".into())),
        }
    }

    fn comparison(&mut self, name: &str) -> Result<Expr> {
        let field = Field::from_name(name)
            .ok_or_else(|| Error::Query(format!("unknown field '{name}'")))?;
        let op = match self.next() {
            Some(Token::Op(o)) => match o {
                "=" => Op::Eq,
                "!=" => Op::Ne,
                "<" => Op::Lt,
                "<=" => Op::Le,
                ">" => Op::Gt,
                ">=" => Op::Ge,
                _ => Op::Contains,
            },
            _ => return Err(Error::Query(format!("expected an operator after '{name}'"))),
        };
        let raw = match self.next() {
            Some(Token::Word(w)) | Some(Token::Str(w)) => w,
            _ => return Err(Error::Query(format!("expected a value after '{name}'"))),
        };
        let value = typed_value(field, op, &raw)?;
        Ok(Expr::Cmp { field, op, value })
    }
}

fn typed_value(field: Field, op: Op, raw: &str) -> Result<Value> {
    let ordered = !matches!(op, Op::Contains);
    let equality = matches!(op, Op::Eq | Op::Ne);
    let unsupported = || Error::Query(format!("operator not supported for field '{field}'"));
    let q = Error::Query;
    match field {
        Field::Id if ordered => raw
            .parse()
            .map(Value::Int)
            .map_err(|_| q(format!("invalid id '{raw}'"))),
        Field::Date if ordered => raw.parse().map(Value::Date).map_err(q),
        Field::Month if ordered => raw.parse().map(Value::Month).map_err(q),
        Field::Amount if ordered => Money::parse(raw).map(Value::Money).map_err(q),
        Field::Kind if equality => raw.parse::<Kind>().map(Value::Kind).map_err(q),
        Field::Tag if equality => Ok(Value::Text(raw.to_string())),
        Field::Category | Field::Payee | Field::Note => Ok(Value::Text(raw.to_string())),
        _ => Err(unsupported()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence_and_binds_tighter_than_or() {
        let e = parse("cat=a or cat=b and amount>1").unwrap();
        assert!(matches!(e, Expr::Or(_, _)));
    }

    #[test]
    fn reports_errors() {
        for (q, msg) in [
            ("", "empty expression"),
            ("colour=red", "unknown field 'colour'"),
            ("amount~5", "operator not supported for field 'amount'"),
            ("tag<x", "operator not supported for field 'tag'"),
            ("(cat=a", "missing ')'"),
            ("cat=a cat=b", "unexpected 'cat'"),
            ("date>=2026-13-01", "invalid date"),
        ] {
            let err = parse(q).unwrap_err().to_string();
            assert!(err.contains(msg), "{q}: {err}");
        }
    }
}
