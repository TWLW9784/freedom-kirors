//! 文件原子写工具。
//!
//! 直接 `std::fs::write` 覆写数据文件存在风险：写到一半遇进程崩溃 / 断电 / 磁盘满，
//! 会把原文件截断成半截 JSON，下次启动反序列化失败 → 数据（凭据、客户端 Key、配额
//! 用量、分组、代理池、余额缓存等）全丢。本模块统一提供「先写同目录临时文件 → rename
//! 覆盖」的原子写：rename 在同一文件系统上是原子操作，要么是完整旧文件，要么是完整新
//! 文件，不会出现半截状态。

use std::io;
use std::path::Path;

/// 原子写：先写同目录 `<name>.tmp` 再 rename 覆盖目标路径。
///
/// 临时文件与目标同目录，确保 rename 不跨文件系统（跨文件系统 rename 会失败且非原子）。
/// 失败时尽量清理临时文件。调用方负责并发串行化（如持写锁），本函数只保证单次写原子。
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let tmp = tmp_path(path);
    if let Err(e) = std::fs::write(&tmp, contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 在 Tokio runtime 内用 `block_in_place` 包裹原子写，避免阻塞 worker 线程；
/// 不在 runtime 内时直接同步写。
pub fn write_atomic_blocking(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| write_atomic(path, contents))
    } else {
        write_atomic(path, contents)
    }
}

/// 计算同目录临时文件路径：保留原文件名，追加 `.tmp` 扩展。
fn tmp_path(path: &Path) -> std::path::PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    match path.parent() {
        Some(dir) => dir.join(name),
        None => std::path::PathBuf::from(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_atomic_creates_file() {
        let dir = std::env::temp_dir().join(format!("kr_atomic_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");
        write_atomic(&path, b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        // 临时文件不应残留
        assert!(!dir.join("data.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_write_atomic_overwrites() {
        let dir = std::env::temp_dir().join(format!("kr_atomic_ow_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new-longer-content").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "new-longer-content"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_tmp_path_same_dir() {
        let p = Path::new("/var/data/creds.json");
        let t = tmp_path(p);
        assert_eq!(t, Path::new("/var/data/creds.json.tmp"));
    }
}
