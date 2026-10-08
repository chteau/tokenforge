//! `tmap kit port`: who listens on which TCP port, one line each; optionally kill the holder.
//! Linux: `ss -Hltnp` (fallback /proc/net/tcp*), macOS/BSD: `lsof`, Windows: `netstat -ano`.

use super::util::{cwd, run};
use std::time::Duration;

const HELP: &str = "Who listens where, in one line each.
  tmap kit port            all TCP listeners: port, pid, command
  tmap kit port N          what holds port N (+ its full command line)
  tmap kit port N --kill   SIGTERM it, wait up to 3s, then SIGKILL; confirm the port is free";

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub port: String,
    pub pid: String,
    pub cmd: String,
    pub addr: String,
}

impl Row {
    fn line(&self) -> String {
        format!("{}\t{}\t{}\t{}", self.port, self.pid, self.cmd, self.addr)
    }
}

fn out(cmd: &[&str]) -> String {
    run(cmd, &cwd(), 10, &[], None).stdout
}

fn port_of(addr: &str) -> String {
    addr.rsplit(':').next().unwrap_or("").to_string()
}

#[cfg(any(test, target_os = "linux"))]
/// Parse `ss -Hltnp` output (field 4 = local address; first pid= and ("name").
pub fn parse_ss(text: &str) -> Vec<Row> {
    text.lines()
        .filter_map(|l| {
            let addr = l.split_whitespace().nth(3)?.to_string();
            let pid = l.split_once("pid=").map(|(_, r)| r.chars().take_while(char::is_ascii_digit).collect()).unwrap_or_default();
            let cmd = l.split_once("((\"").or_else(|| l.split_once("(\"")).and_then(|(_, r)| r.split('"').next()).unwrap_or("").to_string();
            Some(Row { port: port_of(&addr), pid, cmd, addr })
        })
        .collect()
}

#[cfg(any(test, not(any(target_os = "linux", windows))))]
/// Parse `lsof -nP -iTCP -sTCP:LISTEN` output.
pub fn parse_lsof(text: &str) -> Vec<Row> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let addr = f.iter().rev().find(|x| x.contains(':'))?.to_string();
            Some(Row { port: port_of(&addr), pid: f.get(1)?.to_string(), cmd: f[0].to_string(), addr })
        })
        .collect()
}

#[cfg(any(test, windows))]
/// Parse `netstat -ano` output (TCP rows in LISTENING state). The state column is localized
/// (ABHÖREN, EN ESCUCHA…), so a listener is recognized by its foreign port 0 (`0.0.0.0:0`, `[::]:0`).
pub fn parse_netstat(text: &str) -> Vec<Row> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() >= 5 && f[0].starts_with("TCP") && (f[3] == "LISTENING" || port_of(f[2]) == "0"))
                .then(|| Row { port: port_of(f[1]), pid: f[4].to_string(), cmd: String::new(), addr: f[1].to_string() })
        })
        .collect()
}

/// Linux without `ss`: /proc/net/tcp{,6} LISTEN sockets, owners found via /proc/*/fd.
#[cfg(target_os = "linux")]
fn proc_rows() -> Vec<Row> {
    use std::collections::HashMap;
    let mut socks = vec![];
    for (f, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        for l in std::fs::read_to_string(f).unwrap_or_default().lines().skip(1) {
            let c: Vec<&str> = l.split_whitespace().collect();
            if c.len() < 10 || c[3] != "0A" {
                continue;
            }
            let Some((ip, p)) = c[1].split_once(':') else { continue };
            let port = u16::from_str_radix(p, 16).unwrap_or(0);
            let bytes: Vec<u8> = (0..ip.len() / 2).filter_map(|i| u8::from_str_radix(&ip[2 * i..2 * i + 2], 16).ok()).collect();
            // Kernel stores each 32-bit word in host (little-endian) order.
            let host: Vec<u8> = bytes.chunks(4).flat_map(|w| w.iter().rev().copied().collect::<Vec<_>>()).collect();
            let addr = if v6 {
                let a: [u8; 16] = host.try_into().unwrap_or([0; 16]);
                format!("[{}]:{port}", std::net::Ipv6Addr::from(a))
            } else {
                let a: [u8; 4] = host.try_into().unwrap_or([0; 4]);
                format!("{}:{port}", std::net::Ipv4Addr::from(a))
            };
            socks.push((c[9].to_string(), addr, port.to_string()));
        }
    }
    let mut owner: HashMap<String, String> = HashMap::new();
    for e in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let pid = e.file_name().to_string_lossy().into_owned();
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        for fd in std::fs::read_dir(e.path().join("fd")).into_iter().flatten().flatten() {
            if let Ok(t) = std::fs::read_link(fd.path()) {
                if let Some(ino) = t.to_string_lossy().strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')) {
                    owner.entry(ino.to_string()).or_insert_with(|| pid.clone());
                }
            }
        }
    }
    socks
        .into_iter()
        .map(|(ino, addr, port)| {
            let pid = owner.get(&ino).cloned().unwrap_or_default();
            let cmd = if pid.is_empty() { String::new() } else { std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim().to_string() };
            Row { port, pid, cmd, addr }
        })
        .collect()
}

fn raw_rows() -> Vec<Row> {
    #[cfg(target_os = "linux")]
    {
        let o = run(&["ss", "-Hltnp"], &cwd(), 10, &[], None);
        if o.code == 127 { proc_rows() } else { parse_ss(&o.stdout) }
    }
    #[cfg(windows)]
    {
        parse_netstat(&out(&["netstat", "-ano"]))
            .into_iter()
            .map(|mut r| {
                r.cmd = exe_name(&r.pid);
                r
            })
            .collect()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        parse_lsof(&out(&["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]))
    }
}

/// Sort numerically by port and keep the first row per port (like `sort -n -u`).
pub fn dedup(mut rows: Vec<Row>) -> Vec<Row> {
    rows.sort_by_key(|r| r.port.parse::<u64>().unwrap_or(0));
    let mut seen = std::collections::HashSet::new();
    rows.retain(|r| seen.insert(r.port.parse::<u64>().unwrap_or(0)));
    rows
}

fn list() -> Vec<Row> {
    dedup(raw_rows())
}

fn holding(p: &str) -> Vec<Row> {
    let want = p.parse::<u64>().ok();
    list().into_iter().filter(|r| if want.is_some() { r.port.parse::<u64>().ok() == want } else { r.port == p }).collect()
}

#[cfg(windows)]
fn exe_name(pid: &str) -> String {
    let filter = format!("PID eq {pid}");
    let o = out(&["tasklist", "/FI", &filter, "/FO", "CSV", "/NH"]);
    o.lines().next().and_then(|l| l.split('"').nth(1)).unwrap_or("").to_string()
}

fn cmdline(pid: &str) -> String {
    #[cfg(target_os = "linux")]
    let s = std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| String::from_utf8_lossy(&b).replace('\0', " ")).unwrap_or_default();
    #[cfg(windows)]
    let s = exe_name(pid);
    #[cfg(not(any(target_os = "linux", windows)))]
    let s = out(&["ps", "-o", "command=", "-p", pid]).trim_end().to_string();
    s.chars().take(200).collect()
}

fn kill(pids: &[String], force: bool) {
    #[cfg(windows)]
    for p in pids {
        let mut c = vec!["taskkill", "/PID", p.as_str(), "/T"];
        if force {
            c.push("/F");
        }
        out(&c);
    }
    #[cfg(not(windows))]
    {
        let mut c = vec!["kill"];
        if force {
            c.push("-9");
        }
        c.extend(pids.iter().map(String::as_str));
        out(&c);
    }
}

pub fn main(args: Vec<String>) -> i32 {
    match args.first().map(String::as_str) {
        Some("-h") | Some("--help") => {
            println!("{HELP}");
            return 0;
        }
        None => {
            println!("port\tpid\tcmd\taddr");
            for r in list() {
                println!("{}", r.line());
            }
            return 0;
        }
        _ => {}
    }
    let p = args[0].as_str();
    let rows = holding(p);
    if rows.is_empty() {
        println!("port {p}: free");
        return 1;
    }
    for r in &rows {
        println!("{}", r.line());
    }
    let mut pids: Vec<String> = rows.iter().map(|r| r.pid.clone()).filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).collect();
    pids.sort();
    pids.dedup();
    if pids.is_empty() {
        println!("(pid hidden: owned by another user; try sudo ss -ltnp)");
        return 0;
    }
    for pid in &pids {
        println!("{pid}: {}", cmdline(pid));
    }
    if args.get(1).map(String::as_str) == Some("--kill") {
        kill(&pids, false);
        for _ in 0..6 {
            if holding(p).is_empty() {
                println!("port {p}: freed");
                return 0;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        kill(&pids, true);
        std::thread::sleep(Duration::from_millis(300));
        if !holding(p).is_empty() {
            println!("port {p}: still held");
            return 1;
        }
        println!("port {p}: freed (SIGKILL)");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ss_lines() {
        let t = "LISTEN 0 4096 127.0.0.1:631 0.0.0.0:* users:((\"cupsd\",pid=1234,fd=7))\nLISTEN 0 128 [::]:22 [::]:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=99,fd=3),(\"sshd\",pid=100,fd=3))\n";
        let r = dedup(parse_ss(t));
        assert_eq!(r.iter().map(Row::line).collect::<Vec<_>>(), vec!["22\t\t\t[::]:22", "631\t1234\tcupsd\t127.0.0.1:631"]);
    }

    #[test]
    fn lsof_and_netstat() {
        let l = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 me 22u IPv6 0x1 0t0 TCP *:3000 (LISTEN)\n";
        assert_eq!(parse_lsof(l)[0].line(), "3000\t4242\tnode\t*:3000");
        let n = "  Proto  Local Address  Foreign Address  State  PID\r\n  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   1000\r\n  TCP    [::]:445   [::]:0   ABHÖREN   4\r\n  TCP 1.2.3.4:5 6.7.8.9:443 ESTABLISHED 7\r\n  UDP 0.0.0.0:53 *:* 99\r\n";
        let r = parse_netstat(n);
        assert_eq!(r.len(), 2);
        assert_eq!((r[1].port.as_str(), r[1].pid.as_str()), ("445", "4"));
    }
}
