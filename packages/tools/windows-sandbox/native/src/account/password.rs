//! Sandbox account passwords: generated from the OS RNG, held only in memory, zeroed on drop.
use crate::Result;
use std::ptr::null_mut;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

const LENGTH: usize = 40;
const CLASSES: [&[u8]; 4] = [
    b"ABCDEFGHJKLMNPQRSTUVWXYZ",
    b"abcdefghijkmnopqrstuvwxyz",
    b"23456789",
    b"!#%+-.:=?@^_~",
];

/// A password. Never `Debug`/`Display`, never serialized except through DPAPI or the handoff pipe.
pub struct Secret(String);

impl Secret {
    pub fn new(text: String) -> Self {
        Secret(text)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: overwriting with zero bytes keeps the string valid UTF-8.
        unsafe {
            for byte in self.0.as_bytes_mut() {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}

fn random(bytes: &mut [u8]) -> Result<()> {
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!("Generate password: status {status:#x}"));
    }
    Ok(())
}

/// 40 characters drawn from four classes, with each class present, so any local complexity policy accepts it.
pub fn generate() -> Result<Secret> {
    let alphabet: Vec<u8> = CLASSES.concat();
    loop {
        let mut bytes = [0u8; LENGTH];
        random(&mut bytes)?;
        // 256 is not a multiple of the alphabet size; rejecting the top range keeps the choice uniform.
        let limit = (256 / alphabet.len() * alphabet.len()) as u8;
        if bytes.iter().any(|b| *b >= limit) {
            continue;
        }
        let text: String = bytes
            .iter()
            .map(|b| alphabet[*b as usize % alphabet.len()] as char)
            .collect();
        if CLASSES
            .iter()
            .all(|class| text.bytes().any(|c| class.contains(&c)))
        {
            return Ok(Secret(text));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_long_varied_and_complex() {
        let first = generate().unwrap();
        let second = generate().unwrap();
        assert_eq!(first.expose().len(), LENGTH);
        assert_ne!(first.expose(), second.expose());
        for class in CLASSES {
            assert!(first.expose().bytes().any(|c| class.contains(&c)));
        }
    }
}
