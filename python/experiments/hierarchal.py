import logging
from crewai import Crew, Task, Agent, Process
import os
from langchain_openai import ChatOpenAI
from tools.search_tools import SearchTools
from datetime import datetime

# Set environment variables
os.environ["OPENAI_API_KEY"] = \"\"
os.environ["SERPER_API_KEY"] = "1edefaec0732d11db50b993ba60539510cc55334"

# Initialize language models
llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

function_calling_llm = ChatOpenAI(
    model="mistral",
    base_url="http://localhost:11434/v1"
)



class AINewsLetterAgents():
    def editor_agent(self, llm):
        return Agent(
            llm=llm,
            role='Editor',
            goal='Oversee the creation of the AI Newsletter',
            backstory="""With a keen eye for detail and a passion for storytelling, you ensure that the newsletter
            not only informs but also engages and inspires the readers. """,
            allow_delegation=True,
            verbose=True,
            max_iter=15
        )

    def news_fetcher_agent(self, llm):
        return Agent(
            llm=llm,
            role='NewsFetcher',
            goal='Fetch the top AI news stories for the day',
            backstory="""As a digital sleuth, you scour the internet for the latest and most impactful developments
            in the world of AI, ensuring that our readers are always in the know.""",
            tools=[SearchTools.search_internet],
            verbose=True,
            allow_delegation=True,
        )

    def news_analyzer_agent(self, llm):
        return Agent(
            llm=llm,
            role='NewsAnalyzer',
            goal='Analyze each news story and generate a detailed markdown summary',
            backstory="""With a critical eye and a knack for distilling complex information, you provide insightful
            analyses of AI news stories, making them accessible and engaging for our audience.""",
            tools=[SearchTools.search_internet],
            verbose=True,
            allow_delegation=True,
        )

    def newsletter_compiler_agent(self, llm):
        return Agent(
            llm=llm,
            role='NewsletterCompiler',
            goal='Compile the analyzed news stories into a final newsletter format',
            backstory="""As the final architect of the newsletter, you meticulously arrange and format the content,
            ensuring a coherent and visually appealing presentation that captivates our readers. Make sure to follow
            newsletter format guidelines and maintain consistency throughout.""",
            verbose=True,
        )


class AINewsLetterTasks():
    def fetch_news_task(self, agent):
        return Task(
            description=f'Fetch top AI news stories from the past 24 hours. The current time is {datetime.now()}.',
            agent=agent,
            async_execution=True,
            expected_output="""A list of top AI news story titles, URLs, and a brief summary for each story from the past 24 hours. 
                Example Output: 
                [
                    {  'title': 'AI takes spotlight in Super Bowl commercials', 
                    'url': 'https://example.com/story1', 
                    'summary': 'AI made a splash in this year\'s Super Bowl commercials...'
                    }, 
                    {{...}}
                ]
            """
        )

    def analyze_news_task(self, agent, context):
        return Task(
            description='Analyze each news story and ensure there are at least 5 well-formatted articles',
            agent=agent,
            async_execution=True,
            context=context,
            expected_output="""A markdown-formatted analysis for each news story, including a rundown, detailed bullet points, 
                and a "Why it matters" section. There should be at least 5 articles, each following the proper format.
                Example Output: 
                '## AI takes spotlight in Super Bowl commercials\n\n
                **The Rundown:
                ** AI made a splash in this year\'s Super Bowl commercials...\n\n
                **The details:**\n\n
                - Microsoft\'s Copilot spot showcased its AI assistant...\n\n
                **Why it matters:** While AI-related ads have been rampant over the last year, its Super Bowl presence is a big mainstream moment.\n\n'
            """
        )

    def compile_newsletter_task(self, agent, context, callback_function):
        return Task(
            description='Compile the newsletter',
            agent=agent,
            context=context,
            expected_output="""A complete newsletter in markdown format, with a consistent style and layout.
                Example Output: 
                '# Top stories in AI today:\\n\\n
                - AI takes spotlight in Super Bowl commercials\\n
                - Altman seeks TRILLIONS for global AI chip initiative\\n\\n

                ## AI takes spotlight in Super Bowl commercials\\n\\n
                **The Rundown:** AI made a splash in this year\'s Super Bowl commercials...\\n\\n
                **The details:**...\\n\\n
                **Why it matters::**...\\n\\n
                ## Altman seeks TRILLIONS for global AI chip initiative\\n\\n
                **The Rundown:** OpenAI CEO Sam Altman is reportedly angling to raise TRILLIONS of dollars...\\n\\n'
                **The details:**...\\n\\n
                **Why it matters::**...\\n\\n
            """,
            callback=callback_function
        )

agents = AINewsLetterAgents()
tasks = AINewsLetterTasks()

from file_io import save_markdown


editor = agents.editor_agent(llm)
news_fetcher = agents.news_fetcher_agent(llm)
news_analyzer = agents.news_analyzer_agent(llm)
newsletter_compiler = agents.newsletter_compiler_agent(llm)

fetch_news_task = tasks.fetch_news_task(news_fetcher)
analyze_news_task = tasks.analyze_news_task(news_analyzer, [fetch_news_task])
compile_newsletter_task = tasks.compile_newsletter_task(
    newsletter_compiler, [analyze_news_task], save_markdown)


# Create the crew with a collaborative process
crew = Crew(
    agents=[editor, news_fetcher, news_analyzer, newsletter_compiler],
    tasks=[fetch_news_task, analyze_news_task, compile_newsletter_task],
    process=Process.hierarchical,
    manager_llm=llm,
    verbose=True
)

# Kick off the crew's work
results = crew.kickoff()

# Print the results
print("Crew Work Results:")
print(results)