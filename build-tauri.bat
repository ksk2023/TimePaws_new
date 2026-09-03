@echo off
call "D:/software/BuildTools/VC/Auxiliary/Build/vcvars64.bat" >nul
cd /d E:/AI_projects/Anchor/apps/desktop-rs/src-tauri
set PATH=C:/Users/keshankun/.cargo/bin;%PATH%
cargo build %*
