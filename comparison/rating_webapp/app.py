"""Blind translation-preference rating tool.

Reads a comparison JSON file (an array of {Translators, Translations} sets --
Translations[i].Targets[j] came from Translators[j]) and serves a
one-item-at-a-time webpage where a human drags the Target translations of one
Source sentence into preference order, or marks a translation "bad" to
exclude it. Ratings are written back into that same file (each
Translations[i] gets a "Rating": {ranked, excluded} field), so reopening the
file resumes exactly where rating left off, with every earlier choice intact.
Use "Open file..." in the page to switch to a different comparison JSON at
any time, and "Show in folder" to locate the current file on disk (e.g. to
send it back once rating is done).

Run:
  python app.py
  (a browser tab opens automatically at http://localhost:5050/)
"""

import json
import os
import subprocess
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request

from settings import DATA_FILE, HOST, LAST_FILE_POINTER, LEGACY_RESULTS_FILE, PORT

app = Flask(__name__)
state_lock = threading.Lock()


def _initial_file():
    if os.path.exists(LAST_FILE_POINTER):
        with open(LAST_FILE_POINTER, encoding="utf-8") as f:
            remembered = f.read().strip()
        if remembered and os.path.isfile(remembered):
            return remembered
    return DATA_FILE if os.path.isfile(DATA_FILE) else None


current_file = {"path": _initial_file()}


def _remember_current_file():
    with open(LAST_FILE_POINTER, "w", encoding="utf-8") as f:
        f.write(current_file["path"])


def _ask_open_path():
    """Native "Open" dialog on this machine (the server IS the user's own
    computer in the packaged desktop app, so this pops up on their screen)."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    initial_dir = os.path.dirname(current_file["path"]) if current_file["path"] else None
    path = filedialog.askopenfilename(
        title="Open comparison JSON",
        filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
        initialdir=initial_dir if initial_dir and os.path.isdir(initial_dir) else None,
    )
    root.destroy()
    return path or None


def _open_path(path):
    if not os.path.isfile(path):
        return jsonify({"error": f"File not found: {path}"}), 400
    try:
        with open(path, encoding="utf-8-sig") as f:
            json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return jsonify({"error": f"Not a valid JSON file: {e}"}), 400
    with state_lock:
        current_file["path"] = path
        _remember_current_file()
    return _items_response()


def load_data():
    with open(current_file["path"], encoding="utf-8-sig") as f:
        return json.load(f)


def save_data(data):
    with open(current_file["path"], "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _legacy_results():
    """One-time fallback for items that don't have an inline Rating yet:
    ratings this tool saved into a separate results.json before ratings
    lived inside the data file. Only applies to the original DATA_FILE, since
    that's the only file that legacy results.json was ever written against."""
    if current_file["path"] != DATA_FILE or not os.path.exists(LEGACY_RESULTS_FILE):
        return {}
    with open(LEGACY_RESULTS_FILE, encoding="utf-8") as f:
        return json.load(f)


def load_items(data):
    """Flatten the nested sets/translations into a flat list of rateable
    items, de-duplicating Target strings that are identical within one item
    into a single card crediting every translator that produced that text.

    Items where every translator produced the same text (so only one unique
    card remains) are left out entirely -- there's no choice to be made, so
    they're never shown to the rater. They stay untouched in the file; only
    the rateable list served to the page omits them."""
    legacy = _legacy_results()
    items = []
    for set_index, translator_set in enumerate(data):
        translators = [t["Translator"] for t in translator_set["Translators"]]
        for item_index, translation in enumerate(translator_set["Translations"]):
            targets = translation["Targets"]
            cards = []  # [{text, translators: [...]}], in first-seen order
            by_text = {}
            for translator_name, target in zip(translators, targets):
                text = target["Target"]
                if text in by_text:
                    by_text[text]["translators"].append(translator_name)
                else:
                    card = {"text": text, "translators": [translator_name]}
                    by_text[text] = card
                    cards.append(card)

            if len(cards) <= 1:
                continue  # every translator agreed (or there's nothing to compare)

            for i, card in enumerate(cards):
                card["id"] = f"{set_index}-{item_index}-{i}"

            item_id = f"{set_index}-{item_index}"
            items.append({
                "id": item_id,
                "source": translation["Source"],
                "cards": cards,
                "rating": translation.get("Rating") or legacy.get(item_id),
            })
    return items


def _items_response():
    if not current_file["path"]:
        return jsonify({"items": [], "resumeIndex": 0, "currentFile": None})
    data = load_data()
    items = load_items(data)
    # resume where the rater left off: first item with no saved rating
    resume_index = next(
        (i for i, item in enumerate(items) if not item["rating"]),
        len(items) - 1 if items else 0,
    )
    return jsonify({
        "items": items,
        "resumeIndex": resume_index,
        "currentFile": current_file["path"],
    })


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/items", methods=["GET"])
def api_items():
    return _items_response()


@app.route("/api/open", methods=["POST"])
def api_open():
    payload = request.get_json()
    path = (payload.get("path") or "").strip().strip('"')
    if not path:
        return jsonify({"error": "No path given"}), 400
    return _open_path(path)


@app.route("/api/open-dialog", methods=["POST"])
def api_open_dialog():
    path = _ask_open_path()
    if not path:
        return jsonify({"cancelled": True})
    return _open_path(path)


@app.route("/api/reveal", methods=["POST"])
def api_reveal():
    path = current_file["path"]
    if not path:
        return jsonify({"error": "No file is open"}), 400
    subprocess.Popen(["explorer", f"/select,{path}"])
    return jsonify({"status": "ok"})


@app.route("/api/save", methods=["POST"])
def api_save():
    payload = request.get_json()
    item_id = payload["itemId"]
    set_index, item_index = (int(p) for p in item_id.split("-"))
    rating = {
        "ranked": payload["ranked"],      # [{text, translators}, ...] best first
        "excluded": payload["excluded"],  # [{text, translators}, ...] marked bad
    }
    with state_lock:
        data = load_data()
        data[set_index]["Translations"][item_index]["Rating"] = rating
        save_data(data)
    return jsonify({"status": "ok"})


@app.route("/api/summary", methods=["GET"])
def api_summary():
    if not current_file["path"]:
        return jsonify({"perTranslator": [], "itemsRated": 0, "itemsTotal": 0})
    data = load_data()
    items = load_items(data)

    stats = {}  # name -> {ranks: [...], bad: 0, seen: 0}

    def entry(name):
        return stats.setdefault(name, {"ranks": [], "bad": 0, "seen": 0})

    rated = 0
    for item in items:
        rating = item["rating"]
        if not rating:
            continue
        rated += 1
        for rank, group in enumerate(rating["ranked"], start=1):
            for name in group["translators"]:
                e = entry(name)
                e["ranks"].append(rank)
                e["seen"] += 1
        for group in rating["excluded"]:
            for name in group["translators"]:
                e = entry(name)
                e["bad"] += 1
                e["seen"] += 1

    per_translator = []
    for name, e in stats.items():
        avg_rank = sum(e["ranks"]) / len(e["ranks"]) if e["ranks"] else None
        per_translator.append({
            "translator": name,
            "avgRank": avg_rank,
            "firstPlaceCount": sum(1 for r in e["ranks"] if r == 1),
            "timesRanked": len(e["ranks"]),
            "badCount": e["bad"],
            "timesSeen": e["seen"],
        })
    per_translator.sort(key=lambda t: (t["avgRank"] is None, t["avgRank"] or 0))

    return jsonify({
        "perTranslator": per_translator,
        "itemsRated": rated,
        "itemsTotal": len(items),
    })


if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}/"
    print("Translation Preference Rating tool is running.")
    print(f"  {url}")
    print("Keep this window open while you work; close it when you're done.")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, debug=False)
