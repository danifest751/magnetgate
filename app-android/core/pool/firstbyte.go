package pool

import (
	"sync"
	"time"

	"magnetgate/core/health"
)

// watchFirstByte judges the plane that carried a stream by the first byte that comes back over it.
//
// The open cannot do that job here. This client does not dial the exit itself: it opens a loopback
// SOCKS connection to the engine, and the engine writes the success reply while it is still sniffing,
// before it has dialled anything. So the open says "1 ms, healthy" for a path that is about to time out
// fifteen seconds later, and says it whether the exit is fast, slow or gone. Measured on the owner's
// phone on 2026-09-19: 530 health checks, a median of 5 ms for that reply against 378 ms for the path
// behind it - and, in the same session, `context deadline exceeded` after 15.6 s on an exit the pool
// had just marked healthy and went on using for half of every request.
//
// The first byte cannot be faked that way: it has travelled the whole chain. Watching it costs no extra
// traffic, because it is the user's own connection being watched, and it reports exactly once.
func watchFirstByte(stream Conn, deadline time.Duration, report func(health.Verdict, time.Duration)) Conn {
	if deadline <= 0 {
		deadline = time.Duration(health.FirstByteDeadlineMs) * time.Millisecond
	}
	watched := &firstByteConn{Conn: stream, started: time.Now(), deadline: deadline, report: report}
	// Silence is evidence too, and nobody will come back to look: a connection that produces nothing is
	// precisely the one whose Read never returns. So the deadline is a timer rather than a check on the
	// next read.
	watched.timer = time.AfterFunc(deadline, func() { watched.judge(false, false) })
	return watched
}

type firstByteConn struct {
	Conn
	started  time.Time
	deadline time.Duration
	report   func(health.Verdict, time.Duration)

	mu     sync.Mutex
	timer  *time.Timer
	judged bool
}

// judge reports at most once. Whichever comes first - a byte, the deadline, or a death - is the verdict
// for this connection, and the rest is ignored: a stream that carried data and then broke says nothing
// bad about the path that carried it.
func (c *firstByteConn) judge(gotByte, closedWithError bool) {
	c.mu.Lock()
	if c.judged {
		c.mu.Unlock()
		return
	}
	c.judged = true
	if c.timer != nil {
		c.timer.Stop()
	}
	c.mu.Unlock()

	took := time.Since(c.started)
	verdict := health.JudgeFirstByte(took.Milliseconds(), c.deadline.Milliseconds(), gotByte, closedWithError)
	if verdict == health.VerdictWait {
		return
	}
	c.report(verdict, took)
}

func (c *firstByteConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.judge(true, false)
	} else if err != nil {
		// Nothing ever came back and the stream is over: this is the failure the open was unable to
		// report, and the only place the pool can learn about it.
		c.judge(false, true)
	}
	return n, err
}

func (c *firstByteConn) Close() error {
	// A stream closed before anything arrived is not counted as a failure: the application may simply
	// have changed its mind, and punishing a plane for that would pause a healthy exit whenever someone
	// closes a tab. The deadline above still covers a path that is genuinely mute.
	c.mu.Lock()
	if !c.judged && c.timer != nil {
		c.timer.Stop()
	}
	c.mu.Unlock()
	return c.Conn.Close()
}
