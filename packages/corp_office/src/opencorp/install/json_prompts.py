"""Questions for ``opencorp``'s setup screen: one ``SetupPrompt`` JSON line out, one ``SetupAnswer`` JSON line back."""

from collections.abc import Mapping, Sequence
from typing import TextIO

from pydantic import BaseModel, ValidationError

from opencorp.install.onboard import OnboardError, closed_input
from opencorp.protocol.models import SetupAnswer, SetupAsk, SetupChoose, SetupSay, SetupSecret, SetupStep


class JsonPrompter:
    """Asks through ``opencorp``'s setup screen: each prompt is a JSON line on ``out``, each answer a JSON line on ``answers``.

    ``preset`` answers questions by their text without asking, as ``TtyPrompter``'s does.
    """

    interactive = True

    def __init__(self, out: TextIO, answers: TextIO, preset: Mapping[str, str] | None = None) -> None:
        self.out = out
        self.answers = answers
        self.preset = {k: v for k, v in (preset or {}).items() if v}

    def _send(self, prompt: BaseModel) -> None:
        self.out.write(prompt.model_dump_json() + "\n")
        self.out.flush()

    def _answer(self, question: str) -> str:
        line = self.answers.readline()
        if not line:
            raise closed_input(question)
        try:
            return SetupAnswer.model_validate_json(line).answer
        except ValidationError:
            # The line may be a secret sent wrong; say only that it wasn't an answer.
            raise OnboardError(f"the answer to {question!r} isn't a setup answer") from None

    def ask(self, question: str, default: str = "") -> str:
        if question in self.preset:
            return self.preset[question]
        self._send(SetupAsk(type="ask", question=question, default=default))
        return self._answer(question).strip() or default

    def choose(self, question: str, options: Sequence[str], default: str = "", typed: bool = False) -> str:
        if question in self.preset:
            return self.preset[question]
        self._send(SetupChoose(type="choose", question=question, options=list(options), default=default, typed=typed))
        answer = self._answer(question)
        if answer in options:
            return answer
        if typed:
            return answer.strip() or default
        if not answer:
            return default
        raise OnboardError(f"the answer to {question!r} isn't one of its options")

    def secret(self, question: str) -> str:
        self._send(SetupSecret(type="secret", question=question))
        return self._answer(question).strip()

    def say(self, text: str) -> None:
        self._send(SetupSay(type="say", text=text))

    def step(self, number: int, total: int, title: str, why: str) -> None:
        self._send(SetupStep(type="step", number=number, total=total, title=title, why=why))
