#!/bin/zsh
# 双击本文件：以 cokeclaw 群机器人身份投递一次已验证的监控告警。
# 发送前会检查 DWS 登录、目标群机器人、Mac 上的唯一群监听器和 Dots 监控规则。
# --check-only 可在终端中只做检查，不发送消息。

set -u
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
cd -- "$SCRIPT_DIR" || exit 1

/usr/bin/env python3 - "$@" <<'PY'
from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


GROUP_NAME = "cokeclaw"
CONVERSATION_ID = "cidt/FnTvzJGUAkPLJy40noqQ=="
EVENT_TYPE = "user_im_message_receive_group"
TRACE_ID = "c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c"
ALERT = """告警：Coke Agent Web 新建会话接口异常
service: coke-agent-web
environment: production
级别：高
现象：用户创建新会话后页面间歇性空白；/api/conversations 返回 null，前端读取 conversation.messages 时触发 TypeError，相关请求返回 500。
Trace ID：c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c
请排查并修复。"""
DB_PATH = Path.home() / "Library/Application Support/Coke Dots Demo/data/dots.db"
LOCK_PATH = Path.home() / "Library/Application Support/Coke Dots Demo/demo-alert-trigger.lock"
RECEIPT_WAIT_SECONDS = 45


class GateError(Exception):
    pass


def dws_binary() -> str:
    found = shutil.which("dws")
    if found:
        return found
    fallback = Path.home() / ".local/bin/dws"
    if fallback.is_file() and os.access(fallback, os.X_OK):
        return str(fallback)
    raise GateError("找不到 DWS CLI。请先安装 dws，再重新双击本文件。")


DWS = dws_binary()


def run_json(args: list[str], label: str, timeout: int = 30) -> dict:
    try:
        result = subprocess.run(
            [DWS, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise GateError(f"{label}超时；尚未发送消息。请确认网络后重新检查。") from exc
    except OSError as exc:
        raise GateError(f"无法运行 DWS CLI（{label}）；尚未发送消息。") from exc
    if result.returncode != 0:
        raise GateError(f"{label}失败（退出码 {result.returncode}）；尚未发送消息。请检查终端中的 DWS 登录和网络状态。")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GateError(f"{label}没有返回有效 JSON；尚未发送消息。") from exc
    if not isinstance(data, dict):
        raise GateError(f"{label}返回格式异常；尚未发送消息。")
    return data


def read_db() -> sqlite3.Connection:
    if not DB_PATH.is_file():
        raise GateError("找不到 Coke Dots Demo 本机数据库；尚未发送消息。请先启动本机 Dots 服务。")
    try:
        return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=3)
    except sqlite3.Error as exc:
        raise GateError("无法只读检查 Coke Dots Demo 数据库；尚未发送消息。") from exc


def preflight() -> dict:
    print("正在检查 DWS、cokeclaw 群监听和 Dots 告警规则……", flush=True)

    auth = run_json(["auth", "status", "--format", "json"], "DWS 登录检查")
    if not auth.get("authenticated"):
        raise GateError("DWS 登录已失效；尚未发送消息。请在终端运行 `dws auth login` 完成授权，再双击本文件。")
    if auth.get("refresh_token_valid") is False:
        raise GateError("DWS 授权已过期；尚未发送消息。请运行 `dws auth login` 重新授权，再双击本文件。")

    with read_db() as db:
        try:
            selection = db.execute(
                "SELECT tenant_id, corp_id FROM dingtalk_group_selections "
                "WHERE conversation_id = ? AND lower(group_name) = lower(?) "
                "ORDER BY selected_at DESC LIMIT 1",
                (CONVERSATION_ID, GROUP_NAME),
            ).fetchone()
            if not selection:
                raise GateError("Dots 中尚未选择 cokeclaw 群；尚未发送消息。")
            tenant_id, expected_corp = selection
            if auth.get("corp_id") != expected_corp:
                raise GateError("当前 DWS 登录组织与 Dots 选定的组织不一致；尚未发送消息。请切换到 CMS 组织后重试。")

            monitors = db.execute(
                "SELECT enabled, keywords_json FROM dingtalk_group_monitors "
                "WHERE tenant_id = ? AND conversation_id = ?",
                (tenant_id, CONVERSATION_ID),
            ).fetchall()
            active = []
            for enabled, keywords_json in monitors:
                try:
                    keywords = json.loads(keywords_json or "[]")
                except json.JSONDecodeError:
                    keywords = []
                if enabled and any(word in ALERT for word in keywords if isinstance(word, str)):
                    active.append(keywords)
            if len(active) != 1:
                raise GateError("Dots 的 cokeclaw 告警监控未启用或规则不匹配；尚未发送消息。请先在 Dots 中启用群监控。")

            receipt_count = db.execute(
                "SELECT COUNT(*) FROM dingtalk_stream_event_receipts WHERE conversation_id = ?",
                (CONVERSATION_ID,),
            ).fetchone()[0]
        except sqlite3.Error as exc:
            raise GateError("Dots 数据库缺少预期的钉钉群监控表；尚未发送消息。") from exc

    members = run_json(
        ["chat", "+chat-members-list", "--group", CONVERSATION_ID,
         "--member-types", "bot", "--format", "json"],
        "cokeclaw 群机器人检查",
    )
    if members.get("conversationId") != CONVERSATION_ID or members.get("complete") is not True:
        raise GateError("无法完整读取 cokeclaw 群成员；尚未发送消息。")
    if members.get("failedCount", 0) != 0 or members.get("partial"):
        raise GateError("读取 cokeclaw 群成员时有失败项；尚未发送消息。")
    bot_entries = [
        item for item in members.get("bots", [])
        if isinstance(item, dict) and str(item.get("name", "")).casefold() == "cokeclawagent"
    ]
    robot_codes = {item.get("robotCode") for item in bot_entries if item.get("robotCode")}
    if not bot_entries or len(robot_codes) != 1:
        raise GateError("cokeclaw 群内没有唯一的 cokeclawagent 机器人身份；尚未发送消息。")
    robot_code = next(iter(robot_codes))

    event_status = run_json(["event", "status", "--format", "json"], "Dots 群消息监听检查")
    bus = event_status.get("bus", {})
    entry = bus.get("entry", {})
    live = bus.get("live", {})
    if entry.get("state") != "running":
        raise GateError("Mac 上的 DWS 事件总线未运行；尚未发送消息。请启动 Dots 的群消息监听后重试。")
    consumers = [
        item for item in live.get("consumers", [])
        if EVENT_TYPE in item.get("event_types", [])
    ]
    if len(consumers) != 1:
        raise GateError("群消息监听器不是唯一实例或尚未订阅群消息；尚未发送消息。请检查 Dots 的监听状态。")
    consumer = consumers[0]
    pid = consumer.get("pid")
    if not isinstance(pid, int):
        raise GateError("无法确认群消息监听进程；尚未发送消息。")
    try:
        ps = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "command="],
            check=False, capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError("无法核实监听器订阅的群；尚未发送消息。") from exc
    listener_command = ps.stdout.strip() if ps.returncode == 0 else ""
    if CONVERSATION_ID not in listener_command or "group" not in listener_command:
        raise GateError("当前监听器未证明订阅 cokeclaw 群；尚未发送消息。")

    return {
        "robot_code": robot_code,
        "consumer_pid": pid,
        "received": int(consumer.get("received", 0)),
        "dropped": int(consumer.get("dropped", 0)),
        "source_state": str(live.get("source_state", {}).get("state", "unknown")),
        "receipt_count": int(receipt_count),
        "bot_entries": len(bot_entries),
        "tenant_id": tenant_id,
    }


def find_new_receipt(
    started_at: dt.datetime,
    baseline_count: int,
    sent_message_ids: set[str],
) -> tuple[str, str, str] | None:
    with read_db() as db:
        rows = db.execute(
            "SELECT r.provider_message_id, r.task_id, r.created_at, t.status, t.engine "
            "FROM dingtalk_stream_event_receipts r "
            "LEFT JOIN tasks t ON t.id = r.task_id AND t.tenant_id = r.tenant_id "
            "WHERE r.conversation_id = ? ORDER BY r.created_at DESC LIMIT 20",
            (CONVERSATION_ID,),
        ).fetchall()
        count = db.execute(
            "SELECT COUNT(*) FROM dingtalk_stream_event_receipts WHERE conversation_id = ?",
            (CONVERSATION_ID,),
        ).fetchone()[0]
    if count <= baseline_count:
        return None

    recent = []
    for row in rows:
        try:
            created = dt.datetime.fromisoformat(str(row[2]).replace("Z", "+00:00"))
        except ValueError:
            continue
        if created >= started_at and row[1]:
            recent.append(row)
    if sent_message_ids:
        recent = [row for row in recent if str(row[0]) in sent_message_ids]
    # If multiple events arrived during the wait and the CLI omitted a provider ID,
    # do not guess which one came from this send.
    if len(recent) != 1:
        return None
    row = recent[0]
    return str(row[1]), str(row[3] or "unknown"), str(row[4] or "unknown")


def message_ids(value: object) -> set[str]:
    """Extract provider message IDs from supported CLI response shapes without printing them."""
    found: set[str] = set()
    id_keys = {"messageid", "message_id", "providermessageid", "provider_message_id", "msgid", "msg_id"}
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).casefold() in id_keys and isinstance(item, (str, int)):
                found.add(str(item))
            else:
                found.update(message_ids(item))
    elif isinstance(value, list):
        for item in value:
            found.update(message_ids(item))
    return found


def send_once(state: dict) -> int:
    try:
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        raise GateError("告警脚本已经在运行；本次没有再次发送。请等待当前窗口结束。") from exc
    except OSError as exc:
        raise GateError("无法建立单实例保护；为避免重复告警，本次未发送。") from exc

    try:
        print("\n检查通过：", flush=True)
        print(f"  目标群：{GROUP_NAME}")
        print(f"  机器人：cokeclawagent（群成员记录 {state['bot_entries']} 条，唯一机器人身份）")
        print(f"  监听器：PID {state['consumer_pid']}，已订阅该群消息")
        print(f"  Dots 监控：已启用；当前群消息回执 {state['receipt_count']} 条")
        if state["source_state"] == "idle":
            print("  Stream 状态：idle（DWS 空闲状态正常；以监听进程和实际回执为准）")
        else:
            print(f"  Stream 状态：{state['source_state']}")
        print("\n即将以群机器人身份发送告警，并等待 Dots 回执：", flush=True)
        print(ALERT, flush=True)
        print(
            "\n注意：这个 Trace ID 以前投递过。每次双击都会产生新的钉钉事件和任务；"
            "重复执行不会自动去重，也不保证重复创建 GitHub PR。",
            flush=True,
        )

        started_at = dt.datetime.now(dt.timezone.utc)
        try:
            result = subprocess.run(
                [DWS, "chat", "+messages-send", "--as", "bot",
                 "--robot-code", state["robot_code"], "--group", CONVERSATION_ID,
                 "--text", ALERT, "--format", "json", "--yes"],
                check=False, capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            print(
                "\nDWS 发送命令超时。消息可能已经投递；为避免重复任务，脚本不会重发。"
                "请先查看 cokeclaw 群和 Dots Activity。",
                flush=True,
            )
            return 2
        except OSError:
            print("\nDWS 发送命令未能启动；脚本不会自动重试。请检查 DWS CLI。", flush=True)
            return 2

        if result.returncode != 0:
            print(
                f"\nDWS 未确认发送成功（退出码 {result.returncode}）。脚本不会重发；"
                "请先检查群消息和 Dots Activity，确认未送达后再手动重试。",
                flush=True,
            )
            return 2
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError:
            response = None
        if isinstance(response, dict) and response.get("success") is False:
            print("\nDWS 返回发送失败。脚本不会自动重试；请先检查群消息和 Dots Activity。", flush=True)
            return 2
        sent_message_ids = message_ids(response)

        print("\nDWS 已接受发送请求；等待 Dots 收到事件并创建任务……", flush=True)
        deadline = time.monotonic() + RECEIPT_WAIT_SECONDS
        while time.monotonic() < deadline:
            try:
                receipt = find_new_receipt(started_at, state["receipt_count"], sent_message_ids)
            except (sqlite3.Error, ValueError, GateError):
                receipt = None
            if receipt:
                task_id, status, engine = receipt
                engine_name = "Pi" if engine.casefold() == "pi" else engine
                print("\n已确认 Dots 收到群事件并创建任务。")
                print(f"  Agent：{engine_name}")
                print(f"  任务状态：{status}")
                print(f"  任务 ID：{task_id}")
                print("\n可在 Dots 的 Activity 中查看后续排查进度。")
                return 0
            time.sleep(2)

        print(
            "\nDWS 发送命令已成功，但 45 秒内没有观察到 Dots 群消息回执。"
            "脚本没有重发；请先检查 cokeclaw 群、Dots Activity 和监听状态，再决定是否重试。",
            flush=True,
        )
        return 3
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def main() -> int:
    check_only = "--check-only" in sys.argv[1:]
    try:
        state = preflight()
        if check_only:
            print("\n检查通过：")
            print(f"  目标群：{GROUP_NAME}")
            print(f"  cokeclawagent：群成员记录 {state['bot_entries']} 条，对应唯一机器人身份")
            print(f"  群消息监听器：PID {state['consumer_pid']}；Stream 状态 {state['source_state']}")
            print(f"  Dots 监控：已启用；历史回执 {state['receipt_count']} 条")
            print("当前为 --check-only 模式，没有发送任何消息。")
            return 0
        return send_once(state)
    except GateError as exc:
        print(f"\n未发送：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    code = main()
    print("\n脚本结束。若 DWS 已接受发送但尚未看到回执，请先检查，不要立即双击重试。")
    sys.exit(code)
PY
SCRIPT_STATUS=$?

if [[ -t 0 ]]; then
  echo
  read -r "REPLY?按回车关闭此窗口..."
fi
exit "$SCRIPT_STATUS"
