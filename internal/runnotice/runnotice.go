// Package runnotice publishes a monitor's conclusion where an operator reads it
// first: the job summary and the annotations tab.
//
// A monitor that keeps a known condition a successful run outcome must name that
// condition in both places. One line in a step log is not evidence an operator
// collects, and a green run that only looks clean in a log is the failure this
// package exists to remove.
//
// Publication fails closed. A conclusion the run cannot publish is evidence the
// run did not read, so the caller must fail rather than print a verdict nobody
// will see.
package runnotice

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const summaryFileMode = 0o600

// ErrUnstatedReason reports that a caller offered a reason code with no stated
// meaning. It is the only refusal this package raises on its own, because only
// the caller owns the reason vocabulary.
var ErrUnstatedReason = errors.New("run reason code has no published meaning")

var (
	errNoSummary     = errors.New("run summary line is empty")
	errBrokenSummary = errors.New("run notice contains a line break")
	errSummaryWrite  = errors.New("run summary file is not writable")
	errAnnotations   = errors.New("run annotation stream rejected the notice")
)

// Conclusion is one monitor verdict in the two registers an operator reads.
type Conclusion struct {
	// Summary is the single line published to the job summary. It is required.
	// A conclusion with no summary is a conclusion the operator cannot read.
	Summary string
	// Warning is the single line published to the annotations tab. An empty
	// Warning publishes no annotation, which is what a clean run does.
	Warning string
}

// Reporter publishes conclusions for one step.
type Reporter struct {
	summaryPath string
	annotations io.Writer
}

// New returns a Reporter. An empty summary path means the runner published no
// summary file, which is what a local run outside Actions looks like. The
// annotation still reaches the log in that case, and the caller decides whether
// a missing summary is fatal.
func New(summaryPath string, annotations io.Writer) *Reporter {
	return &Reporter{summaryPath: strings.TrimSpace(summaryPath), annotations: annotations}
}

// Publish appends the summary line and emits the warning annotation.
//
// The summary is written first because it is the durable record. The annotation
// is derived by the caller from the same line, so the two cannot disagree. A
// line break in either text is refused: the summary is Markdown, but the
// annotation is a workflow command, and one line break inside it would forge a
// second command on the runner.
func (reporter *Reporter) Publish(conclusion Conclusion) error {
	if strings.TrimSpace(conclusion.Summary) == "" {
		return errNoSummary
	}
	if singleLine(conclusion.Summary) != conclusion.Summary ||
		singleLine(conclusion.Warning) != conclusion.Warning {
		return errBrokenSummary
	}
	if reporter.summaryPath != "" {
		file, err := os.OpenFile(
			reporter.summaryPath,
			os.O_APPEND|os.O_CREATE|os.O_WRONLY,
			summaryFileMode,
		)
		if err != nil {
			return errSummaryWrite
		}
		_, writeErr := io.WriteString(file, conclusion.Summary+"\n")
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			return errSummaryWrite
		}
	}
	if conclusion.Warning != "" && reporter.annotations != nil {
		if _, err := fmt.Fprintf(reporter.annotations, "::warning::%s\n", conclusion.Warning); err != nil {
			return errAnnotations
		}
	}
	return nil
}

// singleLine folds any line break to a space so a caller can compare one line
// against its own text.
func singleLine(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}
