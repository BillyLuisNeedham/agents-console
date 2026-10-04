//! The built Console (ui/dist) the server serves: read from disk in a debug build (the checkout's
//! ui/dist, found beside the binary or under the working directory, or wherever the caller points), and
//! embedded in a release build, so the one binary needs nothing installed beside it (ADR-0036).

use std::borrow::Cow;
use std::path::PathBuf;

/// Where the Console's files come from.
#[derive(Debug, Clone)]
pub enum Ui {
    /// A built ui/dist directory on disk.
    Disk(PathBuf),
    /// The ui/dist this binary was built with.
    #[cfg(not(debug_assertions))]
    Embedded,
}

#[cfg(not(debug_assertions))]
#[derive(rust_embed::RustEmbed)]
#[folder = "../../ui/dist"]
#[allow_missing = true]
struct Dist;

/// One served file: its bytes and a stamp that moves when the file does (the page is rebuilt when it
/// moves).
pub struct UiFile {
    pub bytes: Cow<'static, [u8]>,
    pub stamp: f64,
}

impl Ui {
    /// The UI a server uses when the caller names no directory: the embedded build in a release binary;
    /// in a debug one the checkout's ui/dist, looked for above the binary first, then under the working
    /// directory.
    pub fn default_for_build() -> Ui {
        #[cfg(not(debug_assertions))]
        {
            Ui::Embedded
        }
        #[cfg(debug_assertions)]
        {
            Ui::Disk(find_dist().unwrap_or_else(|| PathBuf::from("ui/dist")))
        }
    }

    /// The file at a served path ("/index.html", "/assets/x.js"), or `None` when there is none. A path
    /// with a `..` segment is never served.
    pub fn file(&self, path: &str) -> Option<UiFile> {
        let relative = path.trim_start_matches('/');
        if relative.split('/').any(|segment| segment == "..") {
            return None;
        }
        match self {
            Ui::Disk(dir) => {
                let full = dir.join(relative);
                let meta = std::fs::metadata(&full)
                    .ok()
                    .filter(|meta| meta.is_file())?;
                let bytes = std::fs::read(&full).ok()?;
                Some(UiFile {
                    bytes: Cow::Owned(bytes),
                    stamp: ac_core::js::mtime_ms(&meta),
                })
            }
            #[cfg(not(debug_assertions))]
            Ui::Embedded => Dist::get(relative).map(|file| UiFile {
                bytes: file.data,
                stamp: 0.0,
            }),
        }
    }
}

#[cfg(debug_assertions)]
fn find_dist() -> Option<PathBuf> {
    use std::path::Path;
    let has_dist = |dir: &Path| dir.join("ui/dist/index.html").is_file();
    let from_exe = std::env::current_exe().ok().and_then(|exe| {
        exe.ancestors()
            .skip(1)
            .find(|dir| has_dist(dir))
            .map(Path::to_path_buf)
    });
    from_exe
        .or_else(|| std::env::current_dir().ok().filter(|dir| has_dist(dir)))
        .map(|dir| dir.join("ui/dist"))
}

/// The content type a served file goes with, by its name (server.ts `serveStatic`).
pub fn content_type(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html"
    } else if path.ends_with(".js") {
        "text/javascript"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_files_under_the_directory_and_nothing_above_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>").unwrap();
        let ui = Ui::Disk(dir.path().to_path_buf());
        assert_eq!(&*ui.file("/index.html").unwrap().bytes, b"<html>");
        assert!(ui.file("/missing.js").is_none());
        assert!(ui.file("/../index.html").is_none());
        assert_eq!(content_type("/a/b.js"), "text/javascript");
        assert_eq!(content_type("/x.png"), "application/octet-stream");
    }
}
