"""Concept2 PM5 を USB でつなぎ、漕ぎながら記録する。ブラウザで波形をリアルタイムに見られる

使い方（PCで）:
    pip install pywinusb   （Windows。Mac・Linux は pip install hidapi）
    python pm5_usb.py           # 記録を始める。ブラウザで http://localhost:8750 を開く（終了は Ctrl+C）
    python pm5_usb.py --demo    # PM5 なしで画面を試す（作った波形を流す）

保存するファイル（2つ。名前は日時）:
    pm5_日時.csv      1ストロークごと：時間・距離・ペース・ワット・ピッチ・心拍・引きと戻しの時間・
                      最大の力・平均の力・力が立ち上がるまでの時間・最大までの時間・力の波形
                      → フォーム解析サイトの「Concept2（エルゴ）」欄でそのまま読める
    pm5_日時_raw.csv  すべての測定値（力の波形を 64Hz で時間に沿って並べたもの、漕ぎの状態つき）
                      → 「いつ力を入れたか」をキャッチからの時間で後から解析できる

仕組み:
- PM5 は USB では HID（キーボードなどと同じ種類）として見えるので、Windows は pywinusb、Mac・Linux は hidapi で通信する（ドライバーの入れ替え不要）
- 命令は CSAFE（Concept2 の通信規格）。命令の組み立て・読み取りは Py3Row（BSD ライセンス）の csafe_cmd を使う
- 50ms ごと（PM の受付間隔）に問い合わせる
- 力の波形は PM5 が 64Hz（15.625ms ごと）で測った値（単位 lbs）。前回の問い合わせ以降の分だけ返ってくる
- ストロークの区切り：PM5 の「漕ぎの状態」が 引き(2) になった瞬間＝キャッチ、引き(2) から抜けた瞬間＝引きの終わり
"""

import argparse
import csv
import datetime
import json
import math
import queue
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import csafe_cmd

VENDOR_ID = 0x17A4  # Concept2
MIN_GAP = 0.05      # 問い合わせの最小間隔（秒）。PM の仕様
RATE = 64           # 力の波形の測定回数（1秒あたり）
DRIVE = 2           # 漕ぎの状態：2＝引き（ドライブ）
WORKOUT_END = {10, 11, 12}  # 練習の終わり（終了・中止・記録済み）
PORT = 8750
HERE = Path(__file__).parent

POLL = ["CSAFE_PM_GET_WORKTIME", "CSAFE_PM_GET_WORKDISTANCE", "CSAFE_GETCADENCE_CMD",
        "CSAFE_GETPOWER_CMD", "CSAFE_GETHRCUR_CMD", "CSAFE_PM_GET_FORCEPLOTDATA", 32,
        "CSAFE_PM_GET_STROKESTATE", "CSAFE_PM_GET_WORKOUTSTATE"]

STROKE_HEADER = ["Number", "Time (seconds)", "Distance (meters)", "Pace (seconds)", "Watts", "Stroke Rate",
                 "Heart Rate", "Drive Time (seconds)", "Recovery Time (seconds)", "Peak Force (lbs)",
                 "Average Force (lbs)", "Force Onset (seconds)", "Time To Peak (seconds)", "Force Curve"]
RAW_HEADER = ["Time (seconds)", "Force (lbs)", "Stroke State", "Watts", "Stroke Rate", "Heart Rate", "Distance (meters)"]


# ---------------- PM5 との通信 ----------------
class HidapiLink:
    """Mac・Linux：hidapi で通信する（pip install hidapi）"""

    def __init__(self):
        import hid
        found = hid.enumerate(VENDOR_ID)
        if not found:
            raise LookupError
        self.dev = hid.device()
        self.dev.open_path(found[0]["path"])

    def send(self, data):
        self.dev.write(data)

    def receive(self):
        data = self.dev.read(121, 2000)  # 最大2秒待つ
        return list(data) if data else None

    def close(self):
        self.dev.close()


class WindowsLink:
    """Windows：pywinusb で通信する（pip install pywinusb。Python だけで書かれているので、新しい Python でも入る）"""

    def __init__(self):
        import pywinusb.hid as winhid
        devices = winhid.HidDeviceFilter(vendor_id=VENDOR_ID).get_devices()
        if not devices:
            raise LookupError
        self.dev = devices[0]
        self.dev.open()
        self.inbox = queue.Queue()  # PM5 からの答え（届いた順）
        self.dev.set_raw_data_handler(lambda data: self.inbox.put(list(data)))
        self.reports = {r.report_id: r for r in self.dev.find_output_reports()}  # 送り口（大きさごと）

    def send(self, data):
        while not self.inbox.empty():  # 前の答えの残りを捨てる
            self.inbox.get()
        self.reports[data[0]].send(data)  # data[0]＝送り口の番号（csafe_cmd が大きさに合わせて決める）

    def receive(self):
        try:
            return self.inbox.get(timeout=2)
        except queue.Empty:
            return None

    def close(self):
        self.dev.close()


class PM5:
    """USB（HID）で PM5 と通信する"""

    def __init__(self):
        try:
            self.link = WindowsLink() if sys.platform == "win32" else HidapiLink()
        except LookupError:
            sys.exit("PM5 が見つかりません。USBケーブルとPM5の電源を確認し、Concept2 Utility などPM5を使うアプリを閉じてください。")
        self.last = 0.0

    def ask(self):
        """測定値を問い合わせ、答えを辞書で返す（例：{'CSAFE_GETPOWER_CMD': [205, 88], ...}）"""
        wait = MIN_GAP - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.link.send(csafe_cmd.write(POLL))
        self.last = time.monotonic()
        data = self.link.receive()
        return csafe_cmd.read(data) if data else {}

    def close(self):
        self.link.close()


def read_sample(answer):
    """PM5 の答え → 1回分の値（単位をそろえる）"""
    worktime = answer.get("CSAFE_PM_GET_WORKTIME", [0, 0])
    distance = answer.get("CSAFE_PM_GET_WORKDISTANCE", [0, 0])
    plot = answer.get("CSAFE_PM_GET_FORCEPLOTDATA", [0])
    return {
        "time": (worktime[0] + worktime[1]) / 100,       # 秒（1/100秒単位で返る）
        "distance": (distance[0] + distance[1]) / 10,    # m（1/10m単位で返る）
        "spm": answer.get("CSAFE_GETCADENCE_CMD", [0])[0],
        "watts": answer.get("CSAFE_GETPOWER_CMD", [0])[0],
        "hr": answer.get("CSAFE_GETHRCUR_CMD", [0])[0],
        "force": plot[1:1 + plot[0] // 2],               # 最初の値＝有効なバイト数（2バイトで1点）
        "state": answer.get("CSAFE_PM_GET_STROKESTATE", [0])[0],
        "workout": answer.get("CSAFE_PM_GET_WORKOUTSTATE", [0])[0],
    }


class Demo:
    """PM5 なしで試すための作り物（ピッチ 52・引き 0.45 秒。キャッチ直後に少し遅れて力が立ち上がる）"""

    def __init__(self):
        self.start = time.monotonic()
        self.sent = 0  # 送った波形の点の数（引きの中で）

    def ask(self):
        time.sleep(MIN_GAP)
        t = time.monotonic() - self.start
        period, drive = 60 / 52, 0.45
        phase = t % period
        n = int(t // period)
        driving = phase < drive
        force = []
        if driving:
            target = int(phase * RATE)
            if phase < MIN_GAP * 1.5:
                self.sent = 0
            for i in range(self.sent, target):
                x = i / (drive * RATE)
                force.append(max(0, round(110 * math.sin(math.pi * max(0, x - 0.08) / 0.92) * (1 + 0.1 * math.sin(n)))))
            self.sent = target
        return {"sample": {"time": t, "distance": t * 4.1, "spm": 52, "watts": 200 + (n % 5) * 4, "hr": 140 + min(30, n // 4),
                           "force": force, "state": DRIVE if driving else 4, "workout": 1}}


# ---------------- ストロークの区切り ----------------
def curve_stats(curve):
    """1本の波形から：最大の力、平均の力、力が立ち上がるまで（最大の10%を超えるまで）の時間、最大までの時間（秒）"""
    if not curve or max(curve) <= 0:
        return {}
    peak = max(curve)
    pulling = [f for f in curve if f > 0]
    onset = next(i for i, f in enumerate(curve) if f >= peak * 0.1)
    return {"peak": peak, "avg": round(sum(pulling) / len(pulling), 1),
            "onset": round(onset / RATE, 3), "toPeak": round(curve.index(peak) / RATE, 3)}


class StrokeRecorder:
    """測定値を順に受け取り、1ストロークがそろったら記録（辞書）を返す

    1本の記録は「次のキャッチ」で確定する（PM5 のワット・ピッチは引きが終わってから更新されるため）
    """

    def __init__(self):
        self.count = 0
        self.catch = None      # 今のストロークのキャッチの時刻
        self.drive_end = None  # 今のストロークの引きの終わりの時刻
        self.curve = []        # 今のストロークの力の波形（キャッチから）
        self.driving = False

    def update(self, s):
        driving = s["state"] == DRIVE
        done = None
        if driving and not self.driving:  # キャッチ
            if self.catch is not None:
                done = self.finish(s)
            self.catch, self.drive_end, self.curve = s["time"], None, []
        if self.driving and not driving:  # 引きの終わり
            self.drive_end = s["time"]
        self.curve.extend(s["force"])
        self.driving = driving
        return done

    def finish(self, s):
        """前のストロークを確定する（s＝次のキャッチの時点の値）"""
        self.count += 1
        st = curve_stats(self.curve)
        drive = self.drive_end - self.catch if self.drive_end else None
        recovery = s["time"] - self.drive_end if self.drive_end else None
        watts = s["watts"]
        blank = lambda v, d=2: "" if v is None else round(v, d)
        return {
            "Number": self.count,
            "Time (seconds)": round(self.catch, 2),
            "Distance (meters)": round(s["distance"], 1),
            "Pace (seconds)": round(500 * (2.8 / watts) ** (1 / 3), 1) if watts > 0 else "",
            "Watts": watts,
            "Stroke Rate": s["spm"],
            "Heart Rate": s["hr"] or "",
            "Drive Time (seconds)": blank(drive),
            "Recovery Time (seconds)": blank(recovery),
            "Peak Force (lbs)": st.get("peak", ""),
            "Average Force (lbs)": st.get("avg", ""),
            "Force Onset (seconds)": st.get("onset", ""),
            "Time To Peak (seconds)": st.get("toPeak", ""),
            "Force Curve": " ".join(str(f) for f in self.curve),
        }


def raw_rows(s):
    """1回の測定値 → 生データの行。力の点は 64Hz なので、測った時刻から逆算して時間を振る"""
    common = [s["state"], s["watts"], s["spm"], s["hr"], round(s["distance"], 1)]
    if not s["force"]:
        return [[round(s["time"], 3), ""] + common]
    n = len(s["force"])
    return [[round(s["time"] - (n - 1 - i) / RATE, 3), f] + common for i, f in enumerate(s["force"])]


# ---------------- ブラウザへの配信（Server-Sent Events） ----------------
listeners = []  # 画面ごとの送信待ちの列


def broadcast(message):
    text = json.dumps(message, ensure_ascii=False)
    for q in list(listeners):
        q.put(text)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q = queue.Queue()
            listeners.append(q)
            try:
                while True:
                    self.wfile.write(f"data: {q.get()}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                listeners.remove(q)
        else:
            body = (HERE / "live.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):  # アクセスのたびの表示は出さない
        pass


# ---------------- 本体 ----------------
def clock(sec):
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def main():
    parser = argparse.ArgumentParser(description="Concept2 PM5 を USB で記録する")
    parser.add_argument("--demo", action="store_true", help="PM5 なしで画面を試す")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    name = f"pm5_{datetime.datetime.now():%Y%m%d_%H%M}{'_demo' if args.demo else ''}"
    source = Demo() if args.demo else PM5()
    recorder = StrokeRecorder()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"記録を始めました。ブラウザで http://localhost:{args.port} を開くと波形が見られます（終了は Ctrl+C）。")
    webbrowser.open(f"http://localhost:{args.port}")

    with open(f"{name}.csv", "w", newline="", encoding="utf-8") as sf, open(f"{name}_raw.csv", "w", newline="", encoding="utf-8") as rf:
        strokes = csv.DictWriter(sf, fieldnames=STROKE_HEADER)
        strokes.writeheader()
        raw = csv.writer(rf)
        raw.writerow(RAW_HEADER)
        try:
            while True:
                answer = source.ask()
                s = answer["sample"] if "sample" in answer else read_sample(answer)
                raw.writerows(raw_rows(s))
                broadcast({"type": "sample", **{k: s[k] for k in ("time", "force", "state", "watts", "spm", "hr", "distance")}})
                row = recorder.update(s)
                if row:
                    strokes.writerow(row)
                    sf.flush()
                    rf.flush()  # 途中で止まっても、そこまでの記録を残す
                    broadcast({"type": "stroke", **row})
                    pace = clock(row["Pace (seconds)"]) if row["Pace (seconds)"] else "--"
                    print(f"#{row['Number']:>4} {clock(row['Time (seconds)'])}  {pace}/500m  {row['Watts']:>4}W  "
                          f"{row['Stroke Rate']:>3}spm  心拍 {row['Heart Rate'] or '--'}  最大の力 {row['Peak Force (lbs)']}lbs")
                if s["workout"] in WORKOUT_END and recorder.count:
                    print("PM5 の練習が終わりました。")
                    break
        except KeyboardInterrupt:
            print("\n終了します。")
    server.shutdown()
    if hasattr(source, "close"):
        source.close()
    print(f"{recorder.count} ストロークを保存しました：{name}.csv（サイトで読める）、{name}_raw.csv（全測定値）")


if __name__ == "__main__":
    main()
