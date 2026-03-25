import logging
from crewai import Crew, Task, Agent, Process
from crewai_tools import SerperDevTool
import os
from langchain_openai import ChatOpenAI
from tools.search_tools import SearchTools

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

# Initialize tools
search = SerperDevTool()
"""
# Create a custom logger for agent communication
def setup_custom_logger(name, file_path='agent_communication.log'):
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    # Create file handler to write logs to a file
    handler = logging.FileHandler(file_path)
    handler.setLevel(logging.DEBUG)
    # Define log format
    formatter = logging.Formatter('%(asctime)s - %(message)s')
    handler.setFormatter(formatter)
    # Add handler to logger
    logger.addHandler(handler)
    return logger

# Initialize custom logger
communication_logger = setup_custom_logger('agent_communication')

# Custom function to log agent messages
def log_message(agent_name, message):
    communication_logger.info(f"{agent_name}: {message}")
    """

# Improved Travel Agent with logging
travel_agent = Agent(
    llm=llm,
    function_calling_llm=function_calling_llm,
    role="Expert Travel Consultant Specializing in Tailored Itineraries",
    goal=(
        "Utilize your expertise and available tools to create a comprehensive travel report for {location}, focusing on top attractions, optimal travel times, flight options, accommodations, and important travel advisories. "
        "Emphasize unique experiences, affordability, and traveler satisfaction. Communicate with the itinerary designer to ensure your findings are aligned with the travel plan."
    ),
    backstory=(
        "With over 15 years of experience as a travel consultant, you have a deep understanding of global destinations, hidden gems, and luxury getaways. "
        "You have helped thousands of travelers plan their perfect trips, whether for adventure, relaxation, or cultural exploration. "
        "Your passion lies in creating personalized travel experiences that leave a lasting impression."
    ),
    allow_delegation=False,
    tools=[SearchTools.search_internet],
    verbose=True,
    # message_callback=lambda message: log_message('Travel Agent', message)  # Log messages from Travel Agent
)

# Improved Planner Agent with logging
planner = Agent(
    llm=llm,
    role="Creative and Detailed Itinerary Designer",
    goal=(
        "Using the information provided by the travel consultant, create a comprehensive day-by-day itinerary for a trip to {location}, tailored to various travel styles (adventure, cultural exploration, family-friendly). "
        "Ensure the itinerary balances must-see attractions with unique local experiences and relaxation time. Coordinate with the travel consultant to ensure a perfect travel plan."
    ),
    backstory=(
        "You are a passionate itinerary designer with a keen eye for detail and a love for curating unforgettable travel experiences. "
        "You believe in going beyond the typical tourist routes, creating itineraries that allow travelers to immerse themselves in the local culture and enjoy hidden gems. "
        "You excel in planning trips that are both exciting and stress-free, tailored perfectly to the traveler's interests and needs."
    ),
    allow_delegation=False,
    verbose=True,
    # message_callback=lambda message: log_message('Planner', message)  # Log messages from Planner
)

# Improved Task 1 for Travel Agent
task1 = Task(
    description=(
        "Using the tools available to you, conduct an in-depth exploration of travel options for {location}. Your report should include:\n\n"
        "1. **Top 5 Attractions and Experiences**: Provide detailed descriptions of the top 5 must-see attractions in {location}, considering factors like popularity, uniqueness, and traveler reviews.\n"
        "2. **Best Times to Visit**: Recommend the best times to visit these attractions based on seasons, weather, and local events or festivals.\n"
        "3. **Flight Recommendations**: Offer 3 flight options for various budgets (economy, premium, luxury), including airlines, approximate prices, and duration. Use the internet search tool to find the most recent data.\n"
        "4. **Accommodation Recommendations**: Suggest 3 accommodation options ranging from budget-friendly to luxury stays, including prices, amenities, and location relative to attractions.\n"
        "5. **Travel Advisories and Safety Tips**: Include any important travel advisories, visa requirements, health precautions, or safety tips specific to {location}.\n\n"
        "Ensure that your report is well-structured with clear headings, bullet points, and concise information. Communicate your findings to the itinerary designer to create a cohesive plan."
    ),
    expected_output=(
        "A comprehensive, user-friendly report that includes:\n\n"
        "- **Top Attractions**: Detailed descriptions of the top 5 attractions.\n"
        "- **Recommended Travel Times**: Optimal times to visit based on seasons and events.\n"
        "- **Flight Options**: 3 flight recommendations with airlines, prices, and durations.\n"
        "- **Accommodation Options**: 3 accommodation recommendations with prices, amenities, and locations.\n"
        "- **Travel Advisories**: Important advisories, visa info, health precautions, safety tips.\n\n"
        "Format the report with clear headings and subheadings for each section. Use bullet points and tables where appropriate for clarity. Ensure all information is up-to-date and accurate. Share this information with the itinerary designer."
    ),
    output_file="task1output.txt",
    agent=travel_agent,
)

# Improved Task 2 for Planner
task2 = Task(
    description=(
        "Develop a detailed, multi-day itinerary for {location}, incorporating the following:\n\n"
        "1. **Daily Activities**: Plan 3-5 activities per day, covering morning, afternoon, and evening. Include must-see attractions and unique local experiences.\n"
        "2. **Restaurant Recommendations**: Provide dining options for each day, highlighting local cuisine and any special dietary accommodations.\n"
        "3. **Transportation Details**: Include information on transportation between activities and accommodations, such as walking directions, public transit, or taxi services.\n"
        "4. **Special Events and Festivals**: Highlight any special events or festivals occurring during the travel dates.\n"
        "5. **Alternative Plans**: Offer alternatives for rainy days or unforeseen circumstances.\n"
        "6. **Travel Tips**: Include any tips that would enhance the traveler's experience, such as local customs, etiquette, or insider advice.\n\n"
        "Coordinate with the travel consultant to incorporate the latest recommendations and changes. Ensure the itinerary is well-organized, easy to follow, and engaging."
    ),
    expected_output=(
        "A structured, day-by-day itinerary formatted for easy reading. Each day's schedule should include:\n\n"
        "- **Morning Activities**: Time, activity descriptions, locations.\n"
        "- **Lunch Recommendations**: Restaurant name, type of cuisine, location.\n"
        "- **Afternoon Activities**: Time, activity descriptions, locations.\n"
        "- **Dinner Recommendations**: Restaurant name, type of cuisine, location.\n"
        "- **Evening Activities**: Time, activity descriptions, locations.\n"
        "- **Transportation Details**: How to get from one place to another.\n"
        "- **Special Events**: Any events happening that day.\n"
        "- **Alternative Options**: Suggestions in case of bad weather or closures.\n\n"
        "Include any necessary reservation information, ticket prices, and booking links if possible. Format the itinerary in a clear and engaging way, using tables or bullet points for clarity. Communicate and update with the travel consultant as needed."
    ),
    output_file="task2output.txt",
    agent=planner,
)

# Create the crew with a collaborative process
crew = Crew(
    agents=[travel_agent, planner],
    tasks=[task1, task2],
    process=Process.sequential,  # Use collaborative process for interaction
    verbose=True
)

# Collect input from the user
user_location = input("Enter the location you want to plan the trip for: ")

# Execute the crew with user input for location
result = crew.kickoff(inputs={'location': user_location})
print(result)
