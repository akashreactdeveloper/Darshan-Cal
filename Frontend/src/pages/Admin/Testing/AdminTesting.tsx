import { useState } from 'react';
import axios from 'axios';

// Interfaces for type safety
interface PromptTemplate {
  role: string;
  content: string;
}

interface QuestionResponse {
  question: string;
  options: string[];
  correct_answer: number | number[];
}

interface ReviewResponse {
  is_valid: boolean;
  feedback: string;
}

interface GeneratedQuestion {
  question: string;
  option_1: string;
  option_2: string;
  option_3: string;
  option_4: string;
  correct_answer: number | number[];
  segment: number;
}

interface Segment {
  text: string;
}

const API_KEY = import.meta.env.VITE_REACT_APP_GROQ_API_KEY;

// Utility function for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Prompt templates
const MCQ_TEMPLATE: PromptTemplate = {
  role: "system",
  content: `
    Generate a multiple-choice question in JSON format based on the transcript: {transcript}
    {additional_suggestions}
    warning: Only return the json format and nothing more
    Format:
    {{
        "question": "<question_text>",
        "options": ["<option1>", "<option2>", "<option3>", "<option4>"],
        "correct_answer": <index_of_correct_option>
    }}
  `
};

const REVIEW_TEMPLATE: PromptTemplate = {
  role: "system",
  content: `
    Review the question against the transcript: 
    Transcript: {transcript}
    Question: {question}
    Check:
    1. Does the question accurately reflect the transcript content?
    2. Is the correct answer consistent with the transcript?
    3. Are the options appropriate and relevant?
    4. Correct_answer is the index starting from 0
    Warning: Only return the json format and nothing more
    Return JSON format:
    {{
        "is_valid": <true/false>,
        "feedback": "<detailed feedback if not valid, empty string if valid>"
    }}
  `
};

// Supervisor Agent class with rate limiting
class SupervisorAgent {
  private maxAttempts: number = 3;
  private agent: PromptTemplate = MCQ_TEMPLATE;
  private requestCount: number = 0;
  private lastReset: number = Date.now();

  private async rateLimitCheck() {
    const now = Date.now();
    // Reset counter every minute
    if (now - this.lastReset >= 60000) {
      this.requestCount = 0;
      this.lastReset = now;
    }

    // If approaching limit, wait until next minute
    if (this.requestCount >= 28) { // Leave buffer of 2 requests
      const timeToNextMinute = 60000 - (now - this.lastReset);
      await delay(timeToNextMinute + 100); // Add small buffer
      this.requestCount = 0;
      this.lastReset = Date.now();
    }
  }

  private async generateResponse(
    template: PromptTemplate,
    transcript: string,
    additionalSuggestions: string = ""
  ): Promise<string> {
    await this.rateLimitCheck();
    this.requestCount++;

    try {
      const formattedContent = template.content
        .replace('{transcript}', transcript)
        .replace('{additional_suggestions}', additionalSuggestions);

      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: "llama3-70b-8192",
        messages: [{ role: template.role, content: formattedContent }],
        max_tokens: 100,
        temperature: 0.7
      }, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data as { choices: { message: { content: string } }[] };
      return data.choices[0].message.content;
    } catch (error) {
      console.error('API Error:', error);
      return `Error: ${(error as Error).message}`;
    }
  }

  private isValidJson(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  private async reviewQuestion(transcript: string, question: string): Promise<ReviewResponse> {
    await this.rateLimitCheck();
    this.requestCount++;

    const formattedContent = REVIEW_TEMPLATE.content
      .replace('{transcript}', transcript)
      .replace('{question}', question);

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: "llama3-70b-8192",
      messages: [{ role: "system", content: formattedContent }],
      max_tokens: 200,
      temperature: 1.0
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = response.data as { choices: { message: { content: string } }[] };
    return JSON.parse(data.choices[0].message.content) as ReviewResponse;
  }

  public async generateAndReview(transcript: string): Promise<string> {
    let attempts = 0;
    let additionalSuggestions = "";
    let question = "";

    while (attempts < this.maxAttempts) {
      question = await this.generateResponse(this.agent, transcript, additionalSuggestions);

      if (!this.isValidJson(question)) {
        additionalSuggestions = "Previous attempt failed to produce valid JSON. Ensure the response is valid JSON.";
        attempts++;
        continue;
      }

      const review = await this.reviewQuestion(transcript, question);
      console.log('transcript:', transcript);
      console.log('question:', question);
      console.log('Review:', review);

      if (review.is_valid) {
        return question;
      } else {
        additionalSuggestions = `Previous question was invalid. Feedback: ${review.feedback}. Please generate a new question addressing this feedback.`;
        attempts++;
      }
    }

    return this.isValidJson(question) ? question : '{"error": "Failed to generate valid question after maximum attempts"}';
  }
}

// React Component
const QuizGenerator: React.FC = () => {
  const [questionsJson, setQuestionsJson] = useState<{ questions: GeneratedQuestion[] }>({ questions: [] });
  const [loading, setLoading] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setFileError("No file selected");
      return;
    }

    if (file.type !== "application/json") {
      setFileError("Please upload a JSON file");
      return;
    }

    setLoading(true);
    setFileError(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const data: { segments: Segment[] } = JSON.parse(content);
        
        // Warn if too many segments
        if (data.segments.length > 7) { // 7 * 4 = 28 requests max
          console.warn('Large number of segments may exceed rate limit. Processing may take multiple minutes.');
        }

        const transcripts = data.segments.map(segment => segment.text);
        const supervisor = new SupervisorAgent();
        const newQuestions: { questions: GeneratedQuestion[] } = { questions: [] };

        for (let i = 0; i < transcripts.length; i++) {
          const transcript = transcripts[i];
          const questionStr = await supervisor.generateAndReview(transcript);

          if (supervisor['isValidJson'](questionStr)) {
            const questionJson = JSON.parse(questionStr) as QuestionResponse;
            if (!('error' in questionJson)) {
              newQuestions.questions.push({
                question: questionJson.question,
                option_1: questionJson.options[0],
                option_2: questionJson.options[1],
                option_3: questionJson.options[2],
                option_4: questionJson.options[3],
                correct_answer: questionJson.correct_answer,
                segment: i + 1
              });
            }
          }
        }

        setQuestionsJson(newQuestions);
        localStorage.setItem('generated222_questions', JSON.stringify(newQuestions));
      } catch (error) {
        console.error('Error processing file:', error);
        setFileError("Invalid JSON file or processing error");
      } finally {
        setLoading(false);
      }
    };

    reader.readAsText(file);
  };

  return (
    <div>
      <h1>Generated Quiz Questions</h1>
      <input
        type="file"
        accept=".json"
        onChange={handleFileUpload}
        disabled={loading}
      />
      {fileError && <p style={{ color: 'red' }}>{fileError}</p>}
      {loading ? (
        <p>Loading... (Processing may take time due to API rate limits)</p>
      ) : questionsJson.questions.length > 0 ? (
        <pre>{JSON.stringify(questionsJson, null, 2)}</pre>
      ) : (
        <p>Please upload a JSON file to generate questions</p>
      )}
    </div>
  );
};

export default QuizGenerator;