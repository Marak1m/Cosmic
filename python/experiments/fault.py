
from crewai import Crew, Task, Agent
from crewai_tools import SerperDevTool
import os
from langchain_openai import ChatOpenAI
from tools.search_tools import SearchTools


def log_step(step_info):
    if "AgentAction(tool='_Exception'" in str(step_info):
        return
    with open('step_log.txt', 'a') as f:
        f.write(f"Step Information: {step_info}\n")
        f.write("----------\n")
def clear_log_file(file_path='step_log.txt'):
    open(file_path, 'w').close() 

os.environ["OPENAI_API_KEY"] = \"\"
os.environ["SERPER_API_KEY"] = "1edefaec0732d11db50b993ba60539510cc55334"
llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://44.220.61.68:11434/v1"
)

llm_backup = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

function_calling_llm = ChatOpenAI(
    model="mistral",
    base_url="http://localhost:11434/v1"
)

def get_log_context(file_path='step_log.txt'):
    with open(file_path, 'r') as f:
        log_context = f.read()
    return log_context


# Tools
search = SerperDevTool()

# Create the agent
def initialize_travel_agent(llm_model):
    return Agent(
        llm = llm_model,
        function_calling_llm=function_calling_llm,
        role="Highly experienced travel agent",
        goal="Find the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
        backstory="You are a very experienced travel agent who has worked in the tourism industry for over 10 years, helping people figure out what places to visit and explore at San diego ",
        allow_delegation=False,
        tools=[SearchTools.search_internet],
        verbose=1,
        step_callback=log_step
    )

def initialize_travel_agent_backup(llm_model,log_context):
    return Agent(
        llm = llm_model,
        function_calling_llm=function_calling_llm,
        role="Highly experienced travel agent",
        goal="You need continue from previous step to find the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
        backstory=f"You are a very experienced travel agent who has worked in the tourism industry for over 10 years, helping people figure out what places to visit and explore at San diego. These are the previous step which were done by you before \nPrevious steps:\n{log_context}.",
        allow_delegation=False,
        tools=[SearchTools.search_internet],
        verbose=1,
    
    )


# Create a task
def task1(agent_model,context2):
    return Task(
            description="Search the internet and find the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
            expected_output="A detailed report on the best location to visit, travel and explore at San Diego along with the best flight prices and hotel accommodations.",
            output_file="task1output.txt",
            agent=agent_model,
            context = context2
        )

# Create the second agent
def initialize_planner_agent(llm_model):
    return Agent(
        llm=llm_model,
        role="Itineary Planner",
        goal="Create an engaging itinerary for a trip to the location selected by the travel agent.",
        backstory="You are a seasoned itinerary planner with a passion for crafting memorable travel experiences. You are tasked with creating a detailed itinerary for a trip to the location selected by the travel agent.",
        allow_delegation=False,
        verbose=1,
    )

# Create a task
def task2(agent_model,context1):
    return Task(
        description="Create an engaging itinerary for a trip to the location selected by the travel agent.",
        expected_output="A detailed itinerary for a trip to the location selected by the travel agent.",
        output_file="task2output.txt",
        agent=agent_model,
        context = context1 
    )

# Put all together with the crew

#crew = Crew(agents=[travel_agent, planner], tasks=[task1, task2], verbose=1)
def check(file):
    
    return 1
def f1():
    try:
        clear_log_file()
        travel_agent = initialize_travel_agent(llm)
        taskmain  = task1(travel_agent,[])
        crew = Crew(agents=[travel_agent], tasks=[taskmain])
        print(crew.kickoff())
        return taskmain
        # chekc file condion
    
    except Exception:
        print("Primary agent Failed travel")
        logs_before = get_log_context()
        travel_agent_backup = initialize_travel_agent_backup(llm_backup,logs_before)
        taskmain_backup  = task1(travel_agent_backup,[])
        crew = Crew(agents=[travel_agent_backup], tasks=[taskmain_backup])
        print(crew.kickoff())
        return taskmain_backup

def f2(prevous_output):
    try:
        planner_agent = initialize_planner_agent(llm)
        crew = Crew(agents=[planner_agent], tasks=[task2(planner_agent,[prevous_output])])
        output = crew.kickoff()
        return output
        # chekc file condion
    except Exception:
        print("Primary agent Failed")
        planner_agent_backup = initialize_planner_agent(llm_backup)
        crew = Crew(agents=[planner_agent_backup], tasks=[task2(planner_agent_backup,[prevous_output])])
        output = crew.kickoff()
        print(output)
        return output

def run():
    output = f1()
    print("done work by agent 1")
    f2(output)
run()
