"""pm5_usb.py のテスト（PM5 なしで実行できる）:  python -m unittest test_pm5_usb.py"""

import unittest

import csafe_cmd
from pm5_usb import DRIVE, STROKE_HEADER, StrokeRecorder, curve_stats, expand_curves, raw_rows, read_sample


def le(value, size):
    return [(value >> (8 * i)) & 0xFF for i in range(size)]


def fake_answer(seconds, meters, spm, watts, hr, force, state, workout=1):
    """PM5 の答え（HIDの1回分のデータ）を、仕様どおりの並びで作る"""
    plot = [len(force) * 2] + sum((le(f, 2) for f in force), []) + [0] * (32 - len(force) * 2)
    first = [0xA0, 5] + le(int(seconds * 100), 4) + [0] + [0xA3, 5] + le(int(meters * 10), 4) + [0]
    second = [0x6B, 33] + plot + [0xBF, 1, state] + [0x8D, 1, workout]
    body = [0x01, 0x1A, len(first)] + first + [0xA7, 3] + le(spm, 2) + [0] + [0xB4, 3] + le(watts, 2) + [88] + [0xB0, 1, hr]
    body += [0x1A, len(second)] + second
    checksum = 0
    for b in body:
        checksum ^= b
    stuffed = []
    for b in body + [checksum]:  # 0xF0〜0xF3 は「F3 + 下2ビット」に置き換える
        stuffed += [0xF3, b & 3] if 0xF0 <= b <= 0xF3 else [b]
    return csafe_cmd.read([0x02, 0xF1] + stuffed + [0xF2] + [0] * 20)


class ReadSample(unittest.TestCase):
    def test_units(self):
        s = read_sample(fake_answer(12.34, 56.7, 52, 205, 148, [10, 240, 30], DRIVE))
        self.assertAlmostEqual(s["time"], 12.34)
        self.assertAlmostEqual(s["distance"], 56.7)
        self.assertEqual((s["spm"], s["watts"], s["hr"], s["state"]), (52, 205, 148, DRIVE))
        self.assertEqual(s["force"], [10, 240, 30])


def sample(t, state, force=(), watts=200):
    return {"time": t, "distance": t * 4, "spm": 52, "watts": watts, "hr": 140, "force": list(force), "state": state, "workout": 1}


class Strokes(unittest.TestCase):
    def test_split_at_catch(self):
        r = StrokeRecorder()
        rows = [r.update(s) for s in [
            sample(0.00, 4),
            sample(0.05, DRIVE, [0, 0, 20]),  # キャッチ（最初は力0）
            sample(0.10, DRIVE, [60, 100, 80]),
            sample(0.15, 3, [40]),             # 引きの終わり
            sample(0.60, 4),
            sample(1.20, DRIVE, [0, 30], watts=210),  # 次のキャッチ → 1本目が確定
        ]]
        done = [x for x in rows if x]
        self.assertEqual(len(done), 1)
        row = done[0]
        self.assertEqual(row["Number"], 1)
        self.assertEqual(row["Time (seconds)"], 0.05)
        self.assertEqual(row["Drive Time (seconds)"], 0.1)
        self.assertEqual(row["Recovery Time (seconds)"], 1.05)
        self.assertEqual(row["Peak Force (lbs)"], 100)
        self.assertEqual(row["Force Curve"], "0 0 20 60 100 80 40")
        self.assertEqual(row["Watts"], 210)  # PM5 は引きの後に更新するので、次のキャッチ時点の値
        self.assertEqual(row["Force Onset (seconds)"], round(2 / 64, 3))  # 最大100の10%（10）を超えた点＝3点目

    def test_curve_stats_empty(self):
        self.assertEqual(curve_stats([]), {})
        self.assertEqual(curve_stats([0, 0]), {})


class Raw(unittest.TestCase):
    def test_force_times(self):
        rows = raw_rows(sample(1.0, DRIVE, [5, 6, 7]))
        self.assertEqual([r[0] for r in rows], [round(1 - 2 / 64, 3), round(1 - 1 / 64, 3), 1.0])
        self.assertEqual([r[1] for r in rows], [5, 6, 7])
        self.assertEqual(raw_rows(sample(2.0, 4))[0][:3], [2.0, "", 4])


class Expand(unittest.TestCase):
    def test_curve_columns(self):
        text = ",".join(STROKE_HEADER) + "\n" + "1,0.1,4,120,200,52,140,0.4,0.7,110,77,0.06,0.2,0 50 110\n" + "2,1.2,8,120,200,52,140,0.4,0.7,90,60,0.06,0.2,0 90\n"
        lines = expand_curves(text).strip().split("\n")
        head = lines[0].split(",")
        self.assertEqual(head[-3:], ["Force 0.000s (lbs)", "Force 0.016s (lbs)", "Force 0.031s (lbs)"])
        self.assertNotIn("Force Curve", head)
        self.assertEqual(lines[1].split(",")[-3:], ["0", "50", "110"])
        self.assertEqual(lines[2].split(",")[-3:], ["0", "90", ""])


if __name__ == "__main__":
    unittest.main()
