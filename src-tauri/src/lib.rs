mod commands;
mod logging;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod network_policy;
mod plugins;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("orientation")
                .setup(|app, api| {
                    #[cfg(target_os = "android")]
                    {
                        let handle = api.register_android_plugin("com.hghub.player", "OrientationPlugin")?;
                        app.manage(commands::OrientationPlugin(handle));
                    }
                    #[cfg(not(target_os = "android"))]
                    let _ = (app, api);
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            network_policy::bind_security(&dir);
            hghub_hpp::proxy::bind(&dir);
            let manager = std::sync::Arc::new(
                hghub_hpp::PluginManager::open(dir.join("hpp"))?
                    .with_document_reader(std::sync::Arc::new(plugins::PickedDocuments(app.handle().clone()))),
            );
            app.manage(manager.clone());
            // The WebView registers its playback capabilities before the first
            // plugin command; eager initialization would expose an incorrect env.
            #[cfg(target_os = "macos")]
            macos_titlebar::create_main_window(app)?;
            #[cfg(target_os = "ios")]
            if let Some(window) = app.get_webview_window("main") {
                // WKWebView 默认按安全区自动内缩（顶 + 底），页面高度被少算、底部露出原生黑底。
                // 改为 UIScrollViewContentInsetAdjustmentNever(=2)，安全区交给 CSS env() 处理。
                let _ = window.with_webview(|webview| unsafe {
                    use objc2::{msg_send, runtime::AnyObject};
                    let wk = webview.inner() as *mut AnyObject;
                    if wk.is_null() { return; }
                    let scroll: *mut AnyObject = msg_send![&*wk, scrollView];
                    if scroll.is_null() { return; }
                    let _: () = msg_send![&*scroll, setContentInsetAdjustmentBehavior: 2isize];
                    let _: () = msg_send![&*scroll, setBounces: false];
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plugins::hpp_manage,
            plugins::pick_plugin_files,
            commands::app_boot,
            commands::security_set,
            commands::set_orientation,
            commands::debug_log,
            commands::open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running HGhub");
}
