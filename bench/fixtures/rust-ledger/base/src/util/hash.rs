//! Non-cryptographic hashing used for change detection and duplicate checks.

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 64-bit FNV-1a. Stable across runs and platforms, unlike `DefaultHasher`.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Hash several fields, separated so that `("ab", "c")` and `("a", "bc")` differ.
pub fn fnv1a_fields(fields: &[&str]) -> u64 {
    let mut buf = Vec::new();
    for f in fields {
        buf.extend_from_slice(f.as_bytes());
        buf.push(0x1f);
    }
    fnv1a(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(fnv1a(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a(b"a"), 0xaf63dc4c8601ec8c);
        assert_ne!(fnv1a_fields(&["ab", "c"]), fnv1a_fields(&["a", "bc"]));
    }
}
