from crewai import Crew, Task, Agent, Process
from crewai_tools import SerperDevTool
import os
from langchain_openai import ChatOpenAI
from tools.search_tools import SearchTools
import threading
import time
os.environ["SERPER_API_KEY"] = "1edefaec0732d11db50b993ba60539510cc55334"


# Set environment variables
os.environ["OPENAI_API_KEY"] = \"\"

# Initialize language models
llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

function_calling_llm = ChatOpenAI(
    model="mistral",
    base_url="http://localhost:11434/v1"
)

# Tools
search = SerperDevTool()

# Shared context to hold the memory
shared_context = {
    "travel_agent_memory": {},
    "backup_status": None
}

# Travel Agent Custom Action with Error Handling
def travel_agent_action(agent, shared_context):
    try:
        # Perform the agent's task logic here (simulated)
        result = agent.perform_task()
        
        # Save result in shared context
        with context_lock:
            shared_context["travel_agent_memory"]["result"] = result
            shared_context["travel_agent_memory"]["status"] = "Completed"
        
        # Save result to file
        with open("task1output.txt", "w") as f:
            f.write(result)
        
        print("Travel Agent completed the task successfully.")
    except Exception as e:
        # Save failure state in shared context
        with context_lock:
            shared_context["travel_agent_memory"]["status"] = f"Failed with error: {str(e)}"
        print(f"Travel Agent failed: {str(e)}")
        # Re-raise the exception to handle it outside this function if needed
        raise

# Backup Agent Custom Action using the shared context
def backup_agent_action(agent, shared_context):
    with context_lock:
        travel_agent_memory = shared_context.get("travel_agent_memory", {})
        
    if travel_agent_memory.get("status", "").startswith("Failed"):
        try:
            # Continue task from the previous state (simulated)
            result = agent.perform_task(previous_memory=travel_agent_memory)
            
            # Save result in shared context
            with context_lock:
                shared_context["travel_agent_memory"]["result"] = result
                shared_context["travel_agent_memory"]["status"] = "Completed by Backup"
            
            # Save result to file
            with open("task1output.txt", "w") as f:
                f.write(result)
            
            print("Backup Agent completed the task successfully.")
        except Exception as e:
            with context_lock:
                shared_context["backup_status"] = f"Backup agent also failed: {str(e)}"
            print(f"Backup Agent failed: {str(e)}")
            raise
    else:
        print("No need for Backup Agent; primary agent succeeded.")

# Planner Agent Custom Action
def planner_agent_action(agent, travel_report):
    try:
        # Use the travel report to create an itinerary
        result = f"Generated Itinerary based on the report: {travel_report}"
        
        # Save the result to file
        with open("task2output.txt", "w") as f:
            f.write(result)
        
        print("Planner Agent completed the itinerary successfully.")
    except Exception as e:
        print(f"Planner Agent failed: {str(e)}")
        raise

# Primary Travel Agent
travel_agent = Agent(
    llm=llm,
    function_calling_llm=function_calling_llm,
    role="Highly experienced travel agent",
    goal="Find the best location to visit, travel, and explore in San Diego along with the best flight prices and hotel accommodations.",
    backstory="You are a very experienced travel agent who has worked in the tourism industry for over 10 years, helping people figure out what places to visit and explore in San Diego.",
    allow_delegation=False,
    tools=[SearchTools.search_internet],
    verbose=1,
    custom_action=lambda: travel_agent_action(travel_agent, shared_context)
)

# Backup Agent
backup_agent = Agent(
    llm=llm,
    role="Backup Travel Agent",
    goal="Take over and complete the task if the primary travel agent fails.",
    backstory="You are a backup travel agent, ready to step in and complete the task when the primary agent encounters issues.",
    allow_delegation=False,
    tools=[SearchTools.search_internet],
    verbose=1,
    custom_action=lambda: backup_agent_action(backup_agent, shared_context)
)

# Task for Travel Agent and Backup Agent
task1 = Task(
    description="Search the internet and find the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
    expected_output="A detailed report on the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
    output_file="task1output.txt",
    agent=travel_agent,  # Start with primary agent
)

# Create the crew for travel agents
crew_travel = Crew(
    agents=[travel_agent, backup_agent],  # Both agents in the crew
    tasks=[task1],  # Only one task, which will switch agents if needed
    process=Process.sequential,  # Use sequential process
    verbose=1,
)

# Run the crew for travel agents with primary and backup handling
try:
    crew_travel.kickoff()  # Execute primary agent
except Exception:
    print("Primary agent failed, switching to backup...")
    task1.agent = backup_agent  # Switch task agent to backup
    crew_travel.kickoff()  # Execute backup agent

# Second Step: Planner Agent
planner = Agent(
    llm=llm,
    role="Itinerary Planner",
    goal="Create an engaging itinerary for a trip to the location selected by the travel agent.",
    backstory="You are a seasoned itinerary planner with a passion for crafting memorable travel experiences. You are tasked with creating a detailed itinerary for a trip to the location selected by the travel agent.",
    allow_delegation=False,
    verbose=1,
    custom_action=lambda: planner_agent_action(planner, travel_report)
)

# Task for Planner Agent
task2 = Task(
    description="Create an engaging itinerary for a trip to the location selected by the travel agent.",
    expected_output="A detailed itinerary for a trip to the location selected by the travel agent.",
    output_file="task2output.txt",
    agent=planner,
)

# Read the context from the travel agent's output file
with open("task1output.txt", "r") as f:
    travel_report = f.read()

# Create the crew for the planner agent
crew_planner = Crew(
    agents=[planner],
    tasks=[task2],
    process=Process.sequential,
    verbose=1,
)

# Run the planner agent task using the context from the travel agent's output
crew_planner.kickoff()
