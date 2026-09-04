// 发布给用户的形态是托盘常驻 GUI：任何构建都不挂控制台窗口
#![windows_subsystem = "windows"]

fn main() {
    timepaws_lib::run()
}
