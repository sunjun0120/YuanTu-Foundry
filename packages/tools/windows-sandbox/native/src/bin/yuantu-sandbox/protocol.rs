//! Messages between exec, broker, and runner. Version 1; unknown fields are refused.
use crate::win::Result;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

pub const VERSION: u32 = 1;
/// Workspace write capability plus the command's scratch capability.
pub const MAX_CAPABILITIES: usize = 2;

/// One command, as the host writes it to the exec request file.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    /// `argv[0]` is the absolute path of the image; no PATH search happens inside the sandbox launcher.
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub capabilities: Vec<String>,
    /// Same meaning as Node's `windowsVerbatimArguments`: arguments after the image are joined unquoted,
    /// which `cmd.exe /d /s /c "..."` needs because cmd does not recognise quoted built-ins.
    #[serde(default)]
    pub verbatim: bool,
    /// A terminal of this size: the command runs on a pseudo console the runner creates, instead of on the pipes
    /// the host passed. Absent for every ordinary command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<Size>,
}

/// Columns and rows of a terminal.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Size {
    pub columns: u16,
    pub rows: u16,
}

/// The largest terminal accepted, in either direction.
pub const MAX_TERMINAL: u16 = 1000;

impl Size {
    pub fn validate(self) -> Result<()> {
        if (1..=MAX_TERMINAL).contains(&self.columns) && (1..=MAX_TERMINAL).contains(&self.rows) {
            Ok(())
        } else {
            Err("Invalid terminal size".into())
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    InvalidRequest,
    LaunchFailed,
    RunnerLost,
    NotReady,
    LeaseConflict,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ToRunner {
    Spawn {
        id: u64,
        request: Request,
        stdin: u64,
        stdout: u64,
        stderr: u64,
    },
    Cancel {
        id: u64,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FromRunner {
    Started {
        id: u64,
        pid: u32,
    },
    Exit {
        id: u64,
        code: u32,
    },
    Error {
        id: u64,
        kind: ErrorKind,
        message: String,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ToBroker {
    Spawn {
        request: Request,
        stdin: u64,
        stdout: u64,
        stderr: u64,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FromBroker {
    Started { pid: u32 },
    Exit { code: u32 },
    Error { kind: ErrorKind, message: String },
}

/// A domain SID of the shape this product generates: `S-1-5-21-a-b-c-d`, each part a u32.
pub fn is_capability_sid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-5-21-") else {
        return false;
    };
    let parts: Vec<_> = rest.split('-').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.len() <= 10 && part.parse::<u32>().is_ok())
}

fn plain(text: &str, what: &str) -> Result<()> {
    if text.contains('\0') {
        return Err(format!("{what} contains NUL"));
    }
    Ok(())
}

pub fn validate(request: &Request) -> Result<()> {
    if request.version != VERSION {
        return Err("Unsupported sandbox request version".into());
    }
    let Some(image) = request.argv.first() else {
        return Err("Request has no program".into());
    };
    if !Path::new(image).is_absolute() {
        return Err("Program path must be absolute".into());
    }
    if !Path::new(&request.cwd).is_absolute() {
        return Err("Working directory must be absolute".into());
    }
    for argument in &request.argv {
        plain(argument, "Argument")?;
    }
    plain(&request.cwd, "Working directory")?;
    for (key, value) in &request.env {
        if key.is_empty() || key.contains('=') {
            return Err("Invalid environment key".into());
        }
        plain(key, "Environment key")?;
        plain(value, "Environment value")?;
    }
    if request.capabilities.len() > MAX_CAPABILITIES {
        return Err("Too many capabilities".into());
    }
    if !request
        .capabilities
        .iter()
        .all(|sid| is_capability_sid(sid))
    {
        return Err("Invalid capability SID".into());
    }
    if let Some(size) = request.tty {
        size.validate()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        Request {
            version: VERSION,
            argv: vec![
                r"C:\Windows\System32\cmd.exe".into(),
                "/c".into(),
                "exit".into(),
            ],
            cwd: r"C:\Windows".into(),
            env: BTreeMap::from([("PATH".into(), r"C:\Windows".into())]),
            capabilities: vec!["S-1-5-21-1-2-3-4".into()],
            verbatim: false,
            tty: None,
        }
    }

    #[test]
    fn accepts_a_valid_request() {
        validate(&request()).unwrap();
    }

    #[test]
    fn a_terminal_size_is_optional_and_bounded() {
        let mut terminal = request();
        terminal.tty = Some(Size {
            columns: 120,
            rows: 40,
        });
        validate(&terminal).unwrap();
        for (columns, rows) in [
            (0, 24),
            (80, 0),
            (MAX_TERMINAL + 1, 24),
            (80, MAX_TERMINAL + 1),
        ] {
            terminal.tty = Some(Size { columns, rows });
            assert!(validate(&terminal).is_err(), "{columns}x{rows}");
        }
        let text = r#"{"version":1,"argv":[],"cwd":"C:\\","env":{},"capabilities":[],"tty":{"columns":80,"rows":24,"x":1}}"#;
        assert!(serde_json::from_str::<Request>(text).is_err());
    }

    #[test]
    fn refuses_unknown_fields() {
        let text =
            r#"{"version":1,"argv":[],"cwd":"C:\\","env":{},"capabilities":[],"network":true}"#;
        assert!(serde_json::from_str::<Request>(text).is_err());
        assert!(serde_json::from_str::<ToRunner>(r#"{"type":"cancel","id":1,"x":0}"#).is_err());
    }

    #[test]
    fn refuses_invalid_requests() {
        let cases: Vec<Box<dyn Fn(&mut Request)>> = vec![
            Box::new(|r| r.version = 2),
            Box::new(|r| r.argv.clear()),
            Box::new(|r| r.argv[0] = "cmd.exe".into()),
            Box::new(|r| r.cwd = "relative".into()),
            Box::new(|r| r.argv.push("a\0b".into())),
            Box::new(|r| {
                r.env.insert("".into(), "x".into());
            }),
            Box::new(|r| {
                r.env.insert("A=B".into(), "x".into());
            }),
            Box::new(|r| {
                r.env.insert("A".into(), "x\0".into());
            }),
            Box::new(|r| r.capabilities = vec!["S-1-1-0".into()]),
            Box::new(|r| r.capabilities = vec!["S-1-5-21-1-2-3".into()]),
            Box::new(|r| r.capabilities = vec!["S-1-5-21-1-2-3-99999999999".into()]),
            Box::new(|r| r.capabilities = vec!["S-1-5-21-1-2-3-4".into(); 3]),
        ];
        for (index, mutate) in cases.iter().enumerate() {
            let mut value = request();
            mutate(&mut value);
            assert!(validate(&value).is_err(), "case {index} was accepted");
        }
    }
}
