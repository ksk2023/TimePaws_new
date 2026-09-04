//! 开机自启（M5）：HKCU\Software\Microsoft\Windows\CurrentVersion\Run\TimePaws
//! 只用 windows crate，不引新依赖；非 Windows 平台为空实现。

#[cfg(target_os = "windows")]
mod imp {
    use windows::core::w;
    use windows::Win32::System::Registry::*;

    const RUN_KEY: windows::core::PCWSTR =
        w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
    const VALUE_NAME: windows::core::PCWSTR = w!("TimePaws");

    pub fn is_enabled() -> bool {
        unsafe {
            let mut hkey = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, Some(0), KEY_QUERY_VALUE, &mut hkey).is_err() {
                return false;
            }
            let ok = RegQueryValueExW(hkey, VALUE_NAME, None, None, None, None).is_ok();
            let _ = RegCloseKey(hkey);
            ok
        }
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        unsafe {
            let mut hkey = HKEY::default();
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                RUN_KEY,
                Some(0),
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                &mut hkey,
            )
            .ok()
            .map_err(|e| format!("打开 Run 键失败: {e:?}"))?;

            let result = if enabled {
                let exe = std::env::current_exe()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                let wide: Vec<u16> = exe.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
                RegSetValueExW(hkey, VALUE_NAME, Some(0), REG_SZ, Some(bytes))
                    .ok()
                    .map_err(|e| format!("写入自启项失败: {e:?}"))
            } else {
                RegDeleteValueW(hkey, VALUE_NAME)
                    .ok()
                    .map_err(|e| format!("删除自启项失败: {e:?}"))
            };
            let _ = RegCloseKey(hkey);
            result
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn is_enabled() -> bool {
        false
    }
    pub fn set_enabled(_enabled: bool) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::{is_enabled, set_enabled};
