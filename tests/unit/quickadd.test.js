// parseQuickAdd turns one typed line into assignment-form fields.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from '../../public/js/quickadd.js';

// Wednesday, Nov 11 2026, 3:00pm local (TZ is pinned by the test script).
const NOW = new Date(2026, 10, 11, 15, 0);
const GROUPS = [
  { id: 'bio',  name: 'AP Biology', tabId: 'school' },
  { id: 'hist', name: 'History',    tabId: 'school' },
  { id: 'calc', name: 'Calculus',   tabId: 'school' },
  { id: 'thea', name: 'Theater',    tabId: 'clubs' },
  { id: 'chem', name: 'Chemistry',  tabId: 'clubs' },
  { id: 'chm2', name: 'Chemistry',  tabId: 'school' },
];
const parse = (s, opts = {}) => parseQuickAdd(s, { groups: GROUPS, activeTabId: 'school', now: NOW, ...opts });

describe('dates', () => {
  const cases = [
    ['essay today',           '2026-11-11'],
    ['essay tonight',         '2026-11-11'],
    ['essay tomorrow',        '2026-11-12'],
    ['essay tmrw',            '2026-11-12'],
    ['essay in 3 days',       '2026-11-14'],
    ['essay in a week',       '2026-11-18'],
    ['essay next week',       '2026-11-18'],
    ['essay nov 20',          '2026-11-20'],
    ['essay November 20th',   '2026-11-20'],
    ['essay 20 nov',          '2026-11-20'],
    ['essay 11/20',           '2026-11-20'],
    ['essay 11/20/27',        '2027-11-20'],
    ['essay nov 20, 2027',    '2027-11-20'],
    ['essay fri',             '2026-11-13'],
    ['essay next friday',     '2026-11-13'],
    ['essay due monday',      '2026-11-16'],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" → ${want}`, () => {
      const r = parse(input);
      assert.equal(r.deadline, want);
      assert.equal(r.description, 'essay');
    });
  }

  test('a weekday that is today means next week', () => {
    assert.equal(parse('essay wed').deadline, '2026-11-18');
  });

  test('a past month/day with no year rolls to next year', () => {
    assert.equal(parse('essay jan 5').deadline, '2027-01-05');
    assert.equal(parse('essay 3/1').deadline, '2027-03-01');
  });

  test('impossible dates are ignored', () => {
    const r = parse('essay feb 30');
    assert.equal(r.deadline, null);
  });

  test('"SAT" in capitals is the test, not Saturday', () => {
    const r = parse('SAT practice');
    assert.equal(r.deadline, null);
    assert.equal(r.description, 'SAT practice');
  });

  test('no date or time leaves both empty', () => {
    const r = parse('read chapter 4');
    assert.equal(r.deadline, null);
    assert.equal(r.deadlineTime, null);
    assert.equal(r.description, 'read chapter 4');
  });
});

describe('times', () => {
  const cases = [
    ['essay fri 3pm',      '15:00'],
    ['essay fri 3:30pm',   '15:30'],
    ['essay fri 9 am',     '09:00'],
    ['essay fri 12am',     '00:00'],
    ['essay fri 12pm',     '12:00'],
    ['essay fri 11p',      '23:00'],
    ['essay fri 14:45',    '14:45'],
    ['essay fri at noon',  '12:00'],
    ['essay fri midnight', '23:59'],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" → ${want}`, () => {
      const r = parse(input);
      assert.equal(r.deadlineTime, want);
      assert.equal(r.deadline, '2026-11-13');
      assert.equal(r.description, 'essay');
    });
  }

  test('a time with no date is today if still ahead', () => {
    assert.equal(parse('essay 5pm').deadline, '2026-11-11');
  });

  test('a time with no date is tomorrow if already passed', () => {
    assert.equal(parse('essay 9am').deadline, '2026-11-12');
  });

  test('13pm is not a time', () => {
    assert.equal(parse('essay 13pm').deadlineTime, null);
  });
});

describe('groups', () => {
  test('a word prefix finds the group and is removed from the start', () => {
    const r = parse('bio lab report fri');
    assert.equal(r.classId, 'bio');
    assert.equal(r.description, 'lab report');
  });

  test('the whole name beats a prefix', () => {
    const r = parse('ap biology lab');
    assert.equal(r.classId, 'bio');
    assert.equal(r.description, 'lab');
  });

  test('a group word at the end is removed too', () => {
    const r = parse('problem set calc');
    assert.equal(r.classId, 'calc');
    assert.equal(r.description, 'problem set');
  });

  test('a group word in the middle stays in the description', () => {
    const r = parse('study for history test');
    assert.equal(r.classId, 'hist');
    assert.equal(r.description, 'study for history test');
  });

  test('ties go to the active space', () => {
    assert.equal(parse('chem worksheet').classId, 'chm2');
    assert.equal(parse('chem worksheet', { activeTabId: 'clubs' }).classId, 'chem');
  });

  test('stopwords and short words don\'t match groups', () => {
    assert.equal(parse('the essay').classId, null);
    assert.equal(parse('ap essay').classId, null);
  });

  test('no groups at all is fine', () => {
    const r = parseQuickAdd('essay fri', { groups: [], now: NOW });
    assert.equal(r.classId, null);
    assert.equal(r.description, 'essay');
  });
});

describe('cleanup', () => {
  test('lead-in words go with the date', () => {
    assert.equal(parse('essay due by fri at 3pm').description, 'essay');
  });

  test('stray punctuation is trimmed', () => {
    assert.equal(parse('essay, fri').description, 'essay');
  });

  test('empty input', () => {
    const r = parse('');
    assert.deepEqual(r, { description: '', classId: null, deadline: null, deadlineTime: null, priority: null, estimateMin: null, repeat: null });
  });
});

describe('priority', () => {
  const cases = [
    ['essay !high',        'high'],
    ['essay !h fri',       'high'],
    ['!! essay',           'high'],
    ['essay !HIGH',        'high'],
    ['essay !low',         'low'],
    ['essay !l',           'low'],
    ['essay',              null],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" → ${want}`, () => {
      const r = parse(input);
      assert.equal(r.priority, want);
      assert.equal(r.description, 'essay');
    });
  }

  test('works alongside a group, date and time', () => {
    const r = parse('bio lab report fri 3pm !high');
    assert.deepEqual(r, { description: 'lab report', classId: 'bio', deadline: '2026-11-13', deadlineTime: '15:00', priority: 'high', estimateMin: null, repeat: null });
  });

  test('a ! inside a word or a run of !!! is part of the description', () => {
    assert.equal(parse('wow!').priority, null);
    assert.equal(parse('wow!').description, 'wow!');
    assert.equal(parse('finish it !!!').priority, null);
    assert.equal(parse('read !hamlet').priority, null);
  });
});

describe('estimate', () => {
  const cases = [
    ['essay ~45m', 45], ['essay ~45', 45], ['essay ~1h', 60], ['essay ~1.5h', 90],
    ['essay ~1h30', 90], ['~1:30 essay', 90], ['essay ~ 2h', 120], ['essay ~2 hrs', 120],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" → ${want} min`, () => {
      const r = parse(input);
      assert.equal(r.estimateMin, want);
      assert.equal(r.description, 'essay');
    });
  }

  test('~1:30 is an estimate, not a due time', () => {
    const r = parse('essay ~1:30');
    assert.equal(r.deadlineTime, null);
    assert.equal(r.deadline, null);
  });

  test('works with everything else', () => {
    const r = parse('bio lab report fri 3pm !high ~45m');
    assert.deepEqual(r, { description: 'lab report', classId: 'bio', deadline: '2026-11-13', deadlineTime: '15:00', priority: 'high', estimateMin: 45, repeat: null });
  });

  test('without the ~ it is just words', () => {
    const r = parse('read 30 min a day');
    assert.equal(r.estimateMin, null);
    assert.equal(r.description, 'read 30 min a day');
  });

  test('a ~ that is not a duration stays put', () => {
    assert.equal(parse('essay ~soon').estimateMin, null);
    assert.equal(parse('essay ~soon').description, 'essay ~soon');
  });
});

describe('repeat', () => {
  // NOW is Wednesday Nov 11 2026.
  const W = (days, interval = 1) => ({ freq: 'weekly', interval, days });
  const cases = [
    ['vocab every day',            { freq: 'daily' },        '2026-11-11'],
    ['vocab daily',                { freq: 'daily' },        '2026-11-11'],
    ['vocab every weekday',        W([1, 2, 3, 4, 5]),       '2026-11-11'],
    ['vocab every mon',            W([1]),                   '2026-11-16'],
    ['vocab every Monday',         W([1]),                   '2026-11-16'],
    ['vocab every wed',            W([3]),                   '2026-11-11'],
    ['vocab every mon, wed & fri', W([1, 3, 5]),             '2026-11-11'],
    ['vocab every tue and thu',    W([2, 4]),                '2026-11-12'],
    ['vocab every mon/wed',        W([1, 3]),                '2026-11-11'],
    ['vocab every other fri',      W([5], 2),                '2026-11-13'],
    ['vocab weekly fri',           W([5]),                   '2026-11-13'],
    ['vocab weekly',               W([3]),                   '2026-11-11'],
    ['vocab biweekly',             W([3], 2),                '2026-11-11'],
    ['vocab monthly',              { freq: 'monthly', day: 11 }, '2026-11-11'],
    ['vocab monthly nov 20',       { freq: 'monthly', day: 20 }, '2026-11-20'],
  ];
  for (const [input, repeat, deadline] of cases) {
    test(`"${input}"`, () => {
      const r = parse(input);
      assert.deepEqual(r.repeat, repeat);
      assert.equal(r.deadline, deadline);
      assert.equal(r.description, 'vocab');
    });
  }

  test('keeps the time and group', () => {
    const r = parse('bio quiz every fri 8am');
    assert.deepEqual([r.classId, r.description, r.deadline, r.deadlineTime], ['bio', 'quiz', '2026-11-13', '08:00']);
    assert.deepEqual(r.repeat, W([5]));
  });

  test('"every" on its own, or inside a word, is just text', () => {
    assert.equal(parse('read every page').repeat, null);
    assert.equal(parse('read every page').description, 'read every page');
    assert.equal(parse('everyday objects essay').repeat, null);
  });
});
