from crewai import Crew, Task, Agent
from crewai_tools import SerperDevTool
import os
import traceback
from langchain_openai import ChatOpenAI
from tools.search_tools import SearchTools

def log_step(step_info):
    if "AgentAction(tool='_Exception'" in str(step_info):
        return
    with open('step_log.txt', 'a') as f:
        f.write(f"{step_info}\n")
        f.write("----------\n")

def log_step_planner(step_info):
    if "AgentAction(tool='_Exception'" in str(step_info):
        return
    with open('step_log_planner.txt', 'a') as f:
        f.write(f"{step_info}\n")
        f.write("----------\n")

def clear_log_file(file_path='step_log.txt'):
    open(file_path, 'w').close()

def clear_planner_log_file(file_path='step_log_planner.txt'):
    open(file_path, 'w').close()

def get_log_context(file_path='step_log.txt'):
    with open(file_path, 'r') as f:
        log_context = f.read()
    return log_context

os.environ["OPENAI_API_KEY"] = \"\"
os.environ["SERPER_API_KEY"] = "1edefaec0732d11db50b993ba60539510cc55334"

llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

llm_backup = ChatOpenAI(
    model="llama3.1",
    base_url="http://localhost:11434/v1"
)

function_calling_llm = ChatOpenAI(
    model="mistral",
    base_url="http://localhost:11434/v1"
)

llm2 = ChatOpenAI(
    model="gemma2",
    base_url="http://localhost:11434/v1"
)

llm3 = ChatOpenAI(
    model="qwen:7b",
    base_url="http://localhost:11434/v1"
)

# Tools
search = SerperDevTool()

def structure_logs_with_local_llm(log_context):
    local_llm = function_calling_llm
    
    messages = [
        {"role": "system", "content": "You are a log summarizer."},
        {"role": "user", "content": f"Convert the following agent logs into a structured format, organizing actions by steps and grouping similar actions together.\n\nLogs:\n{log_context}\n\nStructured Summary:"}
    ]
    
    response = local_llm(messages)
    structured_summary = response[0].content if response else ""
    return structured_summary

def structure_planner_logs_with_local_llm(log_context):
    local_llm = function_calling_llm
    
    messages = [
        {"role": "system", "content": "You are a log summarizer for a planner agent."},
        {"role": "user", "content": f"Convert the following planner agent logs into a structured format, organizing actions by steps and grouping similar actions together.\n\nLogs:\n{log_context}\n\nStructured Summary:"}
    ]
    
    response = local_llm(messages)
    structured_summary = response[0].content if response else ""
    return structured_summary

def initialize_travel_agent(llm_model):
    return Agent(
        llm=llm_model,
        function_calling_llm=function_calling_llm,
        role="Expert Travel Consultant Specializing in San Diego Tourism",
        goal=(
            "Provide a comprehensive and up-to-date report on the top attractions in San Diego, "
            "including hidden gems and popular sites. Additionally, find the most affordable and "
            "convenient flight options from the client's location and recommend highly-rated hotels "
            "that fit within a moderate budget."
        ),
        backstory=(
            "With over a decade of experience in crafting personalized travel experiences, you have "
            "an in-depth knowledge of San Diego's tourism landscape. You stay current with the latest "
            "travel trends, airline deals, and accommodation reviews to offer clients exceptional service."
        ),
        allow_delegation=False,
        tools=[SearchTools.search_internet],
        verbose=1,
        step_callback=log_step
    )

def initialize_travel_agent_backup(llm_model, structured_logs):
    return Agent(
        llm=llm_model,
        function_calling_llm=function_calling_llm,
        role="Expert Travel Consultant Specializing in San Diego Tourism",
        goal=(
            "Continue from previous structured steps to provide a comprehensive and up-to-date report "
            "on the top attractions in San Diego, including hidden gems and popular sites. Additionally, "
            "find the most affordable and convenient flight options from the client's location and recommend "
            "highly-rated hotels that fit within a moderate budget."
        ),
        backstory=(
            f"As an expert travel consultant, you are taking over from previous steps. Here is the structured "
            f"summary of the previous agent's work:\n{structured_logs}\nUse this information to continue providing "
            "exceptional service."
        ),
        allow_delegation=False,
        tools=[SearchTools.search_internet],
        verbose=1,
    )

def task1(agent_model, context):
    return Task(
        description=agent_model.goal,
        expected_output="A detailed report with recommended attractions, flight options, and hotel accommodations.",
        output_file="task1output.txt",
        agent=agent_model,
        context=context
    )

def initialize_planner_agent(llm_model):
    return Agent(
        llm=llm_model,
        role="Creative Itinerary Specialist with a Focus on Client Satisfaction",
        goal=(
            "Design a detailed, day-by-day itinerary for the client's trip to San Diego, incorporating "
            "the attractions identified by the travel agent. Ensure the itinerary balances must-see "
            "landmarks with unique local experiences, and includes dining recommendations and leisure "
            "activities suitable for the client's interests."
        ),
        backstory=(
            "As a passionate itinerary planner, you excel at transforming travel plans into unforgettable "
            "journeys. You pay attention to every detail, from timing and logistics to creating immersive "
            "experiences that reflect the client's preferences and exceed their expectations."
        ),
        allow_delegation=False,
        verbose=1,
        step_callback=log_step_planner
    )

def initialize_planner_agent_backup(llm_model, structured_logs):
    return Agent(
        llm=llm_model,
        role="Creative Itinerary Specialist with a Focus on Client Satisfaction",
        goal=(
            "Continue from previous structured steps to design a detailed, day-by-day itinerary for the client's trip to San Diego."
        ),
        backstory=(
            f"As a creative itinerary specialist, you are picking up from where the previous planner left off. "
            f"Here is a structured summary of the previous steps:\n{structured_logs}\nEnsure a seamless continuation "
            "of the itinerary planning."
        ),
        allow_delegation=False,
        verbose=1,
    )

def task2(agent_model, context):
    return Task(
        description=agent_model.goal,
        expected_output="A comprehensive day-by-day itinerary with activities, dining options, and leisure suggestions.",
        output_file="task2output.txt",
        agent=agent_model,
        context=context
    )

def f1():
    try:
        clear_log_file()
        travel_agent = initialize_travel_agent(llm)
        task_main = task1(travel_agent, context=[])
        crew = Crew(agents=[travel_agent], tasks=[task_main])
        output = crew.kickoff()
        logs_before = get_log_context()
        structured_logs = structure_logs_with_local_llm(logs_before)
        print(structured_logs)
        print(output)
        return output
    except Exception as e:
        print(f"Primary travel agent failed with exception: {e}")
        traceback.print_exc()
        logs_before = get_log_context()
        structured_logs = structure_logs_with_local_llm(logs_before)
        travel_agent_backup = initialize_travel_agent_backup(llm_backup, structured_logs)
        task_main_backup = task1(travel_agent_backup, context=[])
        print(structured_logs)
        crew = Crew(agents=[travel_agent_backup], tasks=[task_main_backup])
        output = crew.kickoff()
        print(output)
        return output

def f2(previous_output):
    try:
        clear_planner_log_file()
        planner_agent = initialize_planner_agent(llm2)
        task_planner = task2(planner_agent, context=[previous_output])
        crew = Crew(agents=[planner_agent], tasks=[task_planner])
        output = crew.kickoff()
        print(output)
        return output
    except Exception as e:
        print(f"Primary planner agent failed with exception: {e}")
        traceback.print_exc()
        logs_before = get_log_context(file_path='step_log_planner.txt')
        structured_logs = structure_planner_logs_with_local_llm(logs_before)
        planner_agent_backup = initialize_planner_agent_backup(llm3, structured_logs)
        print(structured_logs)
        task_planner_backup = task2(planner_agent_backup, context=[previous_output])
        crew = Crew(agents=[planner_agent_backup], tasks=[task_planner_backup])
        output = crew.kickoff()
        print(output)
        return output

def run():
    output = f1()
    print("Done work by agent 1")
    f2(output)

run()
