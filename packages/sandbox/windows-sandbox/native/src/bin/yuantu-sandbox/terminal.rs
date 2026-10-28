//! exec's side of a TTY command. When exec itself runs on a console (the host opened it in a pseudo terminal), its
//! console handles cannot be handed to the runner: they belong to a console the sandboxed command is not attached to,
//! and everything written to them is lost. exec instead hands over two pipes, switches its console to raw VT mode,
//! and copies bytes between the console and the pipes; the runner puts the command on a console of its own and copies
//! the other way. Size changes travel as `resize` messages.
use crate::{
    protocol::Size,
    spawn::{pipe, pump},
    win::{Handle, Result},
};
use std::thread::JoinHandle;
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::Console::{
        CONSOLE_SCREEN_BUFFER_INFO, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT,
        ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleCP, GetConsoleMode, GetConsoleOutputCP,
        GetConsoleScreenBufferInfo, GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        SetConsoleCP, SetConsoleMode, SetConsoleOutputCP,
    },
};

const UTF8: u32 = 65001;

/// exec's console while a TTY command runs. Restores every mode and code page it changed when dropped.
pub struct Terminal {
    input: HANDLE,
    output: HANDLE,
    saved: (u32, u32, u32, u32),
    last: Size,
    /// The ends handed to the broker. Closed once the runner holds its copies, so the command's end of output is
    /// seen here.
    command_input: Option<Handle>,
    command_output: Option<Handle>,
    copier: Option<JoinHandle<()>>,
}

impl Terminal {
    /// `None` when exec's standard output is not a console: then its handles are pipes, which the runner can use
    /// directly.
    pub fn attach() -> Result<Option<Terminal>> {
        let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let output = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        let (mut input_mode, mut output_mode) = (0, 0);
        if unsafe { GetConsoleMode(output, &mut output_mode) } == 0
            || unsafe { GetConsoleMode(input, &mut input_mode) } == 0
        {
            return Ok(None);
        }
        let saved = (input_mode, output_mode, unsafe { GetConsoleCP() }, unsafe {
            GetConsoleOutputCP()
        });
        unsafe {
            SetConsoleMode(
                input,
                (input_mode & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
                    | ENABLE_VIRTUAL_TERMINAL_INPUT,
            );
            SetConsoleMode(
                output,
                output_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN,
            );
            SetConsoleCP(UTF8);
            SetConsoleOutputCP(UTF8);
        }
        let mut terminal = Terminal {
            input,
            output,
            saved,
            last: Size {
                columns: 80,
                rows: 24,
            },
            command_input: None,
            command_output: None,
            copier: None,
        };
        terminal.last = terminal.size().unwrap_or(terminal.last);
        let (command_input, keyboard) = pipe()?;
        let (screen, command_output) = pipe()?;
        let console_input = Handle(duplicate(input)?);
        let console_output = Handle(duplicate(output)?);
        // Keyboard to command: never joined, it ends when exec exits.
        std::thread::spawn(move || pump(&console_input, &keyboard));
        terminal.copier = Some(std::thread::spawn(move || pump(&screen, &console_output)));
        terminal.command_input = Some(command_input);
        terminal.command_output = Some(command_output);
        Ok(Some(terminal))
    }

    /// The handle values exec passes to the broker as the command's stdin, stdout and stderr.
    pub fn handles(&self) -> [u64; 3] {
        let value = |handle: &Option<Handle>| handle.as_ref().map_or(0, |h| h.0 as usize as u64);
        let output = value(&self.command_output);
        [value(&self.command_input), output, output]
    }

    /// The console's visible size.
    pub fn size(&self) -> Option<Size> {
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        if unsafe { GetConsoleScreenBufferInfo(self.output, &mut info) } == 0 {
            return None;
        }
        let size = Size {
            columns: (info.srWindow.Right - info.srWindow.Left + 1).max(1) as u16,
            rows: (info.srWindow.Bottom - info.srWindow.Top + 1).max(1) as u16,
        };
        size.validate().ok().map(|()| size)
    }

    /// The new size when the console changed since the last call.
    pub fn resized(&mut self) -> Option<Size> {
        let size = self.size()?;
        if size == self.last {
            return None;
        }
        self.last = size;
        Some(size)
    }

    /// The runner duplicated the command's ends: close ours, so the command's output ends when it does.
    pub fn handed_over(&mut self) {
        self.command_input = None;
        self.command_output = None;
    }

    /// Waits until everything the command wrote has reached the console.
    pub fn finish(&mut self) {
        self.handed_over();
        if let Some(copier) = self.copier.take() {
            let _ = copier.join();
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let (input_mode, output_mode, input_cp, output_cp) = self.saved;
        unsafe {
            SetConsoleMode(self.input, input_mode);
            SetConsoleMode(self.output, output_mode);
            SetConsoleCP(input_cp);
            SetConsoleOutputCP(output_cp);
        }
    }
}

fn duplicate(handle: HANDLE) -> Result<HANDLE> {
    use windows_sys::Win32::{
        Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
        System::Threading::GetCurrentProcess,
    };
    let mut copy = std::ptr::null_mut();
    crate::win::win(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut copy,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        },
        "Duplicate console handle",
    )?;
    Ok(copy)
}
