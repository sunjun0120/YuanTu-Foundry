fn main() {
    // This restriction applies before any Rust code, including signature checks.
    // Never search the working directory or PATH for an imported dependency.
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_ENV").as_deref(),
        Ok("msvc"),
        "Windows sandbox maintenance requires the MSVC loader configuration"
    );
    println!("cargo:rustc-link-arg=/DEPENDENTLOADFLAG:0x800");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        assert!(
            std::env::var("CARGO_CFG_TARGET_FEATURE")
                .unwrap_or_default()
                .split(',')
                .any(|feature| feature == "crt-static"),
            "Release sandbox helper must use static CRT; build with npm run build:windows-sandbox"
        );
    }
}
