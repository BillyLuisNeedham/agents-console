function initialiseQuizzes(root = document) {
  root.querySelectorAll("[data-quiz]").forEach((quiz) => {
    const feedback = quiz.querySelector(".quiz-feedback");

    quiz.addEventListener("click", (event) => {
      const button = event.target.closest("[data-answer]");

      if (!button || !quiz.contains(button)) {
        return;
      }

      const isCorrect = button.dataset.answer === "true";

      quiz.querySelectorAll("[data-answer]").forEach((option) => {
        option.classList.remove("correct", "wrong");
        option.setAttribute("aria-pressed", "false");
      });

      button.classList.add(isCorrect ? "correct" : "wrong");
      button.setAttribute("aria-pressed", "true");

      if (feedback) {
        feedback.textContent = button.dataset.feedback;
        feedback.className = `quiz-feedback ${isCorrect ? "correct" : "wrong"}`;
        feedback.hidden = false;
      }
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initialiseQuizzes());
} else {
  initialiseQuizzes();
}
