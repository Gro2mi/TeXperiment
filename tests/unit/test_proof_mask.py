"""mask_prose command-internal leaks: engines must never see command
syntax like (lr) trim specs or spacing-command punctuation."""
import sys

sys.path.insert(0, '.')
from texperiment.proof import mask_prose

BS = chr(92)


def test_cmidrule_trim_spec_swallowed():
    compact, _ = mask_prose(BS + 'cmidrule(lr){2-5}')
    assert compact == ''
    assert 'lr' not in compact


def test_spacing_commands_inside_prose_arg():
    compact, _ = mask_prose(
        BS + 'textbf{(m' + BS + ',s$^{-1}$)}')
    assert compact == '(m s)'
    assert ',' not in compact


def test_spacing_between_words_is_a_space():
    compact, _ = mask_prose('well' + BS + ',known')
    assert compact == 'well known'


def test_negative_space_vanishes():
    compact, _ = mask_prose('all' + BS + '!good')
    assert compact == 'all good'


def test_escaped_content_chars_stay():
    compact, _ = mask_prose('50' + BS + '% off' + BS + '&more')
    assert '%' in compact and '&' in compact
