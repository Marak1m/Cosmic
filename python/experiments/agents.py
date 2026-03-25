from crewai import Agent, Task, Crew
from tools.search_tools import SearchTools  # Ensure this tool is correctly defined and accessible
import os
from langchain_openai import ChatOpenAI

# Setting up environment variables
os.environ["OPENAI_API_KEY"] = \"\"  

# LLM Configurations
llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

llm2 = ChatOpenAI(
    model="mistral",
    base_url="http://localhost:11434/v1"
)

# Agent Definitions
class AINewsLetterAgents():
    def editor_agent(self):
        return Agent(
            role='Editor',
            goal='Oversee the creation of the AI Newsletter',
            backstory="""With a keen eye for detail and a passion for storytelling, you ensure that the newsletter
            not only informs but also engages and inspires the readers.""",
            allow_delegation=True,
            verbose=True,
            max_iter=15,
            llm=llm,
        )

    def news_fetcher_agent(self):
        return Agent(
            role='NewsFetcher',
            goal='Fetch the top AI news stories for the day',
            backstory="""As a digital sleuth, you scour the internet for the latest and most impactful developments
            in the world of AI, ensuring that our readers are always in the know.""",
            tools=[SearchTools.search_internet],  # Ensure this tool is compatible and defined
            verbose=True,
            allow_delegation=True,
            llm=llm2,
        )

    def news_analyzer_agent(self):
        return Agent(
            role='NewsAnalyzer',
            goal='Analyze each news story and generate a detailed markdown summary',
            backstory="""With a critical eye and a knack for distilling complex information, you provide insightful
            analyses of AI news stories, making them accessible and engaging for our audience.""",
            tools=[SearchTools.search_internet],  # Ensure this tool is compatible and defined
            verbose=True,
            allow_delegation=True,
            llm=llm2
        )

    def newsletter_compiler_agent(self):
        return Agent(
            role='NewsletterCompiler',
            goal='Compile the analyzed news stories into a final newsletter format',
            backstory="""As the final architect of the newsletter, you meticulously arrange and format the content,
            ensuring a coherent and visually appealing presentation that captivates our readers. Make sure to follow
            newsletter format guidelines and maintain consistency throughout.""",
            verbose=True,
            llm=llm,
        )
