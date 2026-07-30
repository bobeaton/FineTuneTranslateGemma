# All settings can be overridden with environment variables.
import os

_here = os.path.dirname(os.path.abspath(__file__))

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
