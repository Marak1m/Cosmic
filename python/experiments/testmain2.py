import os
from crewai import Agent, Task, Crew, Process
from langchain_openai import ChatOpenAI

# Set up OpenAI API key
os.environ["OPENAI_API_KEY"] = \"\"

# Initialize the language model
llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://44.221.77.182:11434/v1"
)

# Define the agents
agent_sme = Agent(
    role="Subject Matter Expert",
    goal="Provide expertise in digital marketing.",
    backstory=(
        "An experienced digital marketer with extensive knowledge in all areas of digital marketing. "
        "Works with the team to ensure the curriculum covers all important topics."
    ),
    llm=llm,
    verbose=True,
    allow_delegation=False
)

agent_curriculum_planner = Agent(
    role="Curriculum Planner",
    goal="Design a detailed course curriculum with modules and content for digital marketing.",
    backstory=(
        "An expert in creating course plans and educational programs. "
        "Collaborates with the team to structure the curriculum in an easy-to-follow way."
    ),
    llm=llm,
    verbose=True,
    allow_delegation=False
)

agent_content_creator = Agent(
    role="Content Creator",
    goal="Develop detailed content for each module of the digital marketing course.",
    backstory=(
        "A skilled content creator who specializes in making engaging and understandable educational materials. "
        "Works with the team to create content that helps learners grasp the concepts."
    ),
    llm=llm,
    verbose=True,
    allow_delegation=False
)

agent_leader = Agent(
    role="Leader",
    goal="Oversee the development of the digital marketing course curriculum and ensure it is detailed and complete. Delegate work to other coworker as follows (task: str, context: str, coworker: Optional[str] = None, **kwargs) - Delegate a specific task to one of the following coworkers: [Subject Matter Expert, Curriculum Planner, Content Creator] The input to this tool should be the coworker, the task you want them to do, and ALL necessary context to execute the task, they know nothing about the task, so share absolute everything you know, don't reference things but instead explain them.",
    backstory=(
        "An experienced project manager who coordinates the team's efforts. "
        "Ensures that the final curriculum meets the requirements and is delivered on time."
    ),
    llm=llm,
    verbose=True,
    allow_delegation=True
)

# Define the tasks
task = Task(
    description="Develop a comprehensive digital marketing course curriculum.",
    expected_output="Provide a detailed digital marketing course curriculum with modules and the content in each one listed in detail."
)

# Configure the Crew with a hierarchical process
crew = Crew(
    agents=[agent_sme, agent_curriculum_planner, agent_content_creator],
    tasks=[task],
    manager_agent=agent_leader,
    process=Process.hierarchical,
    verbose=True
)

# Run the crew to produce the final curriculum
result = crew.kickoff()

# Output the final curriculum
print(result)
