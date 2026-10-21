//! Length-prefixed JSON frames: 4-byte little-endian length, then UTF-8 JSON.
use serde::{Serialize, de::DeserializeOwned};
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 1 << 20;

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| io::Error::other("Serialize frame"))?;
    if bytes.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Frame exceeds 1 MiB"));
    }
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(&bytes);
    // One write per frame, so a frame is never interleaved with another writer's.
    writer.write_all(&frame)?;
    writer.flush()
}

pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> io::Result<T> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Frame exceeds 1 MiB"));
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid frame"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::FromRunner;

    #[test]
    fn round_trips_a_message() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &FromRunner::Exit { id: 3, code: 7 }).unwrap();
        let value: FromRunner = read_frame(&mut buffer.as_slice()).unwrap();
        assert!(matches!(value, FromRunner::Exit { id: 3, code: 7 }));
    }

    #[test]
    fn refuses_an_oversized_header() {
        let header = ((MAX_FRAME + 1) as u32).to_le_bytes();
        let error = read_frame::<_, FromRunner>(&mut header.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn reports_a_truncated_frame_as_eof() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &FromRunner::Exit { id: 1, code: 0 }).unwrap();
        buffer.pop();
        let error = read_frame::<_, FromRunner>(&mut buffer.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
