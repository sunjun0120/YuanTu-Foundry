//! Serializes `account-setup` and `account-uninstall`, including the desktop user's credential and marker writes.
//! The elevated holder keeps the lock through the user's final acknowledgement, not just account/network changes.
//! Mirrors Codex `setup_mutex.rs` (openai/codex@86e17e9).
use crate::Result;
use std::{marker::PhantomData, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::{GetLastError, LocalFree, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
};

/// Only LocalSystem and elevated administrators may open the mutex, so a standard user cannot hold it to block setup.
const SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";
const NAME: &str = r"Global\YuanTuSandboxSetup";

/// The machine-wide setup lock, released on drop. A mutex belongs to the thread that acquired it, so this guard
/// cannot move to another thread.
#[must_use]
pub struct SetupLock {
    handle: crate::Handle,
    _thread_bound: PhantomData<*mut ()>,
}

/// Waits up to `timeout_ms` for the machine-wide lock. Creating a `Global\` object needs `SeCreateGlobalPrivilege`,
/// which elevated administrators have; every caller already runs elevated.
pub fn acquire(timeout_ms: u32) -> Result<SetupLock> {
    acquire_named(NAME, SDDL, timeout_ms)
}

pub(crate) fn acquire_named(name: &str, sddl: &str, timeout_ms: u32) -> Result<SetupLock> {
    let mut descriptor = null_mut();
    crate::win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                crate::wide(sddl)?.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        "Build sandbox setup lock permissions",
    )?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let raw = unsafe { CreateMutexW(&attributes, 0, crate::wide(name)?.as_ptr()) };
    let error = unsafe { GetLastError() };
    unsafe { LocalFree(descriptor) };
    if raw.is_null() {
        return Err(format!(
            "Open the sandbox setup lock: Windows error {error}"
        ));
    }
    let handle = crate::Handle(raw);
    match unsafe { WaitForSingleObject(handle.0, timeout_ms) } {
        // A holder that crashed released the lock; setup repairs whatever it left half done.
        WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(SetupLock {
            handle,
            _thread_bound: PhantomData,
        }),
        WAIT_TIMEOUT => Err(format!(
            "Timed out waiting for the sandbox setup lock after {timeout_ms} ms: another setup or uninstall is running"
        )),
        _ => Err(format!(
            "Wait for the sandbox setup lock: Windows error {}",
            unsafe { GetLastError() }
        )),
    }
}

impl Drop for SetupLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.handle.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A per-test session-local name: the tests run without the privilege a `Global\` name needs.
    fn name(test: &str) -> String {
        format!(
            r"Local\YuanTuSandboxSetupTest-{test}-{}",
            std::process::id()
        )
    }

    fn sddl() -> String {
        format!(
            "D:P(A;;GA;;;{})",
            crate::account::credentials::current_user_sid().unwrap()
        )
    }

    fn try_elsewhere(name: &str, timeout_ms: u32) -> Result<()> {
        let (name, sddl) = (name.to_string(), sddl());
        std::thread::spawn(move || acquire_named(&name, &sddl, timeout_ms).map(drop))
            .join()
            .unwrap()
    }

    #[test]
    fn a_held_lock_makes_another_thread_time_out() {
        let name = name("held");
        let _held = acquire_named(&name, &sddl(), 1_000).unwrap();
        let error = try_elsewhere(&name, 50).unwrap_err();
        assert!(error.contains("Timed out"), "{error}");
    }

    #[test]
    fn a_released_lock_is_free_for_the_next_holder() {
        let name = name("released");
        drop(acquire_named(&name, &sddl(), 1_000).unwrap());
        try_elsewhere(&name, 1_000).unwrap();
    }

    #[test]
    fn a_holder_that_dies_without_releasing_does_not_block_setup_forever() {
        let name = name("abandoned");
        let (inner, sddl) = (name.clone(), sddl());
        // The thread exits while still owning the mutex, which Windows reports to the next waiter as abandoned.
        std::thread::spawn(move || std::mem::forget(acquire_named(&inner, &sddl, 1_000).unwrap()))
            .join()
            .unwrap();
        try_elsewhere(&name, 1_000).unwrap();
    }
}
