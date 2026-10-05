// Circle colours: the five Yarnoo colours, and only those.
//
// Yarnoo's call - the circles on the floor are part of the event's look, so they
// are the Playbook palette rather than generic primaries. The names are the
// short ones a guest can say out loud to a stranger ("I'm Pink"), not the
// Playbook's full names.
//
// Ordered by how far apart they read: the operator picks how many circles are in
// play and gets the first N, so a smaller room still gets the most separable
// set. Measured (CIE76 dE): Magenta/Yellow 131 is the widest pair; Pink/Lilac 26
// is the closest, which is why Pink comes last - physical Pink and Lilac circles
// are the two to light well and keep apart on the floor.
//
// `ink` is the text colour on each: white on Magenta (7.1:1); on the light four
// a deep magenta (#5A093F), because brand magenta on Coral is only 2.5:1.
export const PALETTE = [
  { id: 'magenta', name: 'Magenta', hex: '#A51374', ink: '#FFFFFF' },
  { id: 'yellow',  name: 'Yellow',  hex: '#FDEE4D', ink: '#5A093F' },
  { id: 'lilac',   name: 'Lilac',   hex: '#AFA6FF', ink: '#5A093F' },
  { id: 'coral',   name: 'Coral',   hex: '#FF656C', ink: '#5A093F' },
  { id: 'pink',    name: 'Pink',    hex: '#FFB4FB', ink: '#5A093F' }
];

export const DEFAULT_COLOR_COUNT = 5;
export const DEFAULT_ROUND_MINUTES = 10;

// Icebreakers. Each circle gets a different one each round, so nobody is asked
// the same question twice and no two circles are running the same prompt.
export const QUESTIONS = [
  'What brought you to this event — and what would make it worth it?',
  'What is something you changed your mind about this year?',
  'What part of your job would surprise people who do not do it?',
  'What is the best thing you have read, watched or listened to lately?',
  'Which problem in your industry is everyone ignoring?',
  'What did you want to be when you were ten? How close did you get?',
  'What is one tool or habit you would not give up?',
  'Who in this room would you most like to be introduced to, and why?',
  'What is the most useful piece of advice you were given at work?',
  'What is something you are trying to get better at right now?',
  'What is the smallest change that made the biggest difference for you?',
  'What do you wish clients understood about what you do?',
  'What is a project you are proud of that nobody saw?',
  'If you had a free month and a budget, what would you build?',
  'What is your unpopular opinion about your own field?',
  'Where were you living five years ago, and what changed since?',
  'What is the last thing that genuinely impressed you?',
  'What is a skill outside work that helps you at work?',
  'What would you do differently if you started your career today?',
  'What is one thing you want to walk out of tonight with?'
];

// Assignment cost weights. Tune here, not in the algorithm.
//
// Only the ratios matter. In a big room all three are satisfied at once (zero
// repeats, zero colleagues, everyone changes colour). In a small one they
// collide, and the order below decides who wins: meeting someone new beats
// changing colour. With two colours it has to - every fresh pairing puts one
// person from each old group together, so one of them keeps their colour.
// When moving outranked meeting, four people on two colours walked the floor
// as two fixed couples, swapping circles and never meeting anyone new.
export const WEIGHTS = {
  // Cost of sharing a circle with a colleague from the same company. They can
  // talk at the office; the point of the night is everyone else.
  sameCompany: 400,
  // Cost of sharing a circle with someone you already met. Superlinear, so a
  // necessary second meeting is tolerated but a third is fought hard.
  repeat: 200,
  // Cost of being handed the same colour two rounds running. The room should
  // visibly reshuffle, but staying on a circle to meet new people is fine.
  stayPut: 50
};
