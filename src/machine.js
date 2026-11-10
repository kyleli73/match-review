// idle -> loading -> calibrating -> analyzing -> reviewing, cancel returns to calibrating.
export const STATES = ['idle', 'loading', 'calibrating', 'analyzing', 'reviewing'];

const TRANSITIONS = {
  idle: { load: 'loading' },
  loading: { loaded: 'calibrating', loadedReview: 'reviewing', fail: 'idle' },
  calibrating: { analyze: 'analyzing', review: 'reviewing', close: 'idle' },
  analyzing: { done: 'reviewing', cancel: 'calibrating', error: 'calibrating' },
  reviewing: { recalibrate: 'calibrating', close: 'idle' },
};

export function createMachine(initial = 'idle', onChange = () => {}) {
  const m = {
    state: initial,
    /** Returns true if the transition was legal and applied. */
    send(event) {
      const next = TRANSITIONS[m.state]?.[event];
      if (!next) return false;
      const prev = m.state;
      m.state = next;
      onChange(next, prev, event);
      return true;
    },
  };
  return m;
}
