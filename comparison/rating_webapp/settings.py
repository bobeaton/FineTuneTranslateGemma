# All settings can be overridden with environment variables.
import os
import sys


def _app_dir():
    if getattr(sys, "frozen", False):
        # Running as a bundled exe (PyInstaller --onefile): use the exe's own
        # folder, not sys._MEIPASS (a temp folder deleted on exit), so
        # remembered state (last_file.txt) survives between runs.
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


_here = _app_dir()

# Host to bind to. 127.0.0.1 (default) keeps this reachable only from this
# machine -- appropriate for the packaged single-user desktop app. Set
# HOST=0.0.0.0 to allow other devices on the network to connect instead.
HOST = os.environ.get('HOST', '127.0.0.1')

# The comparison data: an array of {Translators: [{Translator: name}, ...],
# Translations: [{Source, Targets: [{Target: text}, ...], Rating}, ...]}
# objects. Targets[i] corresponds to Translators[i]. Ratings are written back
# into this same file (Translations[i].Rating), so reopening it resumes
# exactly where rating left off. This is only the *initial* file loaded at
# startup -- use the "Load file..." button on the page to switch to any other
# comparison JSON at runtime (the choice is remembered in LAST_FILE_POINTER
# across restarts).
DATA_FILE = os.environ.get(
    'DATA_FILE',
    r'C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\TranslationSamplesToCompare.json',
)

# Remembers the path most recently opened via "Load file...", so restarting
# the server reopens the same file instead of falling back to DATA_FILE.
LAST_FILE_POINTER = os.environ.get(
    'LAST_FILE_POINTER', os.path.join(_here, 'last_file.txt'))

# Ratings saved by the old version of this tool, before ratings were stored
# inline in the data file itself. Only ever read as a one-time fallback, for
# items in DATA_FILE that don't yet have an inline Rating; the next save on
# such an item migrates it into the file itself.
LEGACY_RESULTS_FILE = os.environ.get(
    'LEGACY_RESULTS_FILE', os.path.join(_here, 'results.json'))

PORT = int(os.environ.get('PORT', 5050))
