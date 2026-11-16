"""M1 — .bib parsing for cite autocomplete (texperiment/bibparse.py)."""
from texperiment.bibparse import parse_bib

BIB = '''
@string{jp = {Journal of Physics}}

@article{euler1748,
  author = {Euler, Leonhard and Bernoulli, Daniel and Newton, Isaac
            and Leibniz, Gottfried},
  title = {Introductio in analysin infinitorum},
  journal = jp,
  year = 1748,
  doi = {10.1000/xyz123},
}

@comment{ignored entirely}
@preamble{ "whatever" }

@book{lamport86,
  author = "Lamport, Leslie",
  title = {{LaTeX: A Document Preparation System}},
  year = 1986,
  url = {https://example.org/book},
}
'''


def test_entries_in_file_order():
    entries = parse_bib(BIB)
    assert [e['key'] for e in entries] == ['euler1748', 'lamport86']
    assert entries[0]['type'] == 'article'


def test_string_and_preamble_and_comment_ignored():
    entries = parse_bib(BIB)
    assert all(e['key'] != 'ignored entirely' for e in entries)
    assert 'whatever' not in str(entries)


def test_author_formatting_and_et_al():
    entries = parse_bib(BIB)
    assert entries[0]['authors'] == 'Leonhard Euler et al.'
    assert entries[1]['authors'] == 'Leslie Lamport'


def test_comma_less_author_name_pairing():
    entries = parse_bib('@misc{k, author = {Ada Lovelace and Alan Turing}}')
    assert entries[0]['authors'] == 'Ada Lovelace, Alan Turing'


def test_string_resolution():
    entries = parse_bib(BIB)
    assert entries[0]['journal'] == 'Journal of Physics'


def test_value_concatenation_with_hash():
    # note: concatenation only works without whitespace after the '#'
    entries = parse_bib('@article{k, journal = "Jour" #{nal}}')
    assert entries[0]['journal'] == 'Journal'


def test_year_from_bare_number():
    entries = parse_bib(BIB)
    assert entries[0]['year'] == '1748'


def test_title_braces_stripped():
    entries = parse_bib(BIB)
    assert entries[1]['title'] == 'LaTeX: A Document Preparation System'


def test_url_from_url_field_beats_doi():
    entries = parse_bib(BIB)
    assert entries[1]['url'] == 'https://example.org/book'


def test_url_from_doi_when_no_url():
    entries = parse_bib(BIB)
    assert entries[0]['url'] == 'https://doi.org/10.1000/xyz123'


def test_plain_display_string():
    entries = parse_bib(BIB)
    assert entries[0]['plain'] == ('Leonhard Euler et al. (1748). '
                                   'Introductio in analysin infinitorum. '
                                   'Journal of Physics')
    assert entries[1]['plain'] == ('Leslie Lamport (1986). '
                                   'LaTeX: A Document Preparation System')


def test_unbalanced_entry_skipped_without_killing_the_rest():
    entries = parse_bib('@article{bad, author = {x\n'
                        '@article{good, title = {Fine}}')
    assert [e['key'] for e in entries] == ['good']


def test_quoted_value_with_nested_braces():
    entries = parse_bib('@book{k, title = "The {Nested} Title"}')
    assert entries[0]['title'] == 'The Nested Title'
