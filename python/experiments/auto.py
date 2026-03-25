from autogen import ConversableAgent
from langchain_openai import ChatOpenAI
import os
from autogen import ConversableAgent, FunctionCallingConfig
from langchain_openai import ChatOpenAI

os.environ["OPENAI_API_KEY"] = \"\"


import httpx


class MyHttpClient(httpx.Client):
    def __deepcopy__(self, memo):
        return self

config_list = [
    {
        "model": "llama3.1",
        "api_key": "",
        "http_client": MyHttpClient(proxy="http://44.221.77.182:11434/v1"),
    }
]

llm = ChatOpenAI(
    model="llama3.1",
    base_url="http://44.221.77.182:11434/v1"
)

    

# Define the Curriculum Planner Agent
#curriculum_planner = ConversableAgent(
#    name="Curriculum Planner",
#    system_message=(
#        "You are responsible for designing the course structure. "
#        "Create a comprehensive outline for a digital marketing course."
#    ),
#    llm_config = {"config_list": config_list, "cache_seed": 42}
    
#)

# Define the Curriculum Planner Agent
curriculum_planner = ConversableAgent(
    name="Curriculum Planner",
    system_message=(
        "You are responsible for designing the course structure. "
        "Create a comprehensive outline for a digital marketing course."
    ),
    llm=llm
)

# Define the Subject Matter Expert (SME) Agent
subject_matter_expert = ConversableAgent(
    name="Subject Matter Expert",
    system_message=(
        "You are responsible for providing detailed content and ensuring accuracy. "
        "Enhance the course outline with in-depth information."
    ),
    llm=llm
)

# Define the Content Creator Agent
content_creator = ConversableAgent(
    name="Content Creator",
    system_message=(
        "You are responsible for developing engaging materials based on the curriculum and SME input. "
        "Create detailed content for each module."
    ),
    llm=llm
)

# Define functions for agent interactions
def create_course_outline():
    outline = {
        "course_title": "Digital Marketing Mastery",
        "modules": [
            {"title": "Introduction to Digital Marketing", "objectives": ["Understand basics", "Importance in modern business"]},
            {"title": "SEO Fundamentals", "objectives": ["SEO basics", "Keyword research", "On-page optimization"]},
            {"title": "Content Marketing", "objectives": ["Types of content", "Content strategy", "Distribution channels"]},
            # Additional modules can be added here
        ]
    }
    return outline

def refine_outline(course_outline):
    # Adding expertise-based details to each module
    for module in course_outline["modules"]:
        module["additional_topics"] = ["Latest trends", "Case studies"]
    return course_outline

def generate_content(refined_outline):
    # Drafting content based on refined curriculum
    content = {}
    for module in refined_outline["modules"]:
        content[module["title"]] = {
            "introduction": f"Detailed content for {module['title']}",
            "topics": module["objectives"] + module["additional_topics"]
        }
    return content

# Register functions with agents
curriculum_planner.register_function(
    FunctionCallingConfig(
        name="create_course_outline",
        executor=create_course_outline,
        description="Creates a course outline based on a given prompt."
    )
)

subject_matter_expert.register_function(
    FunctionCallingConfig(
        name="refine_outline",
        executor=refine_outline,
        description="Refines the course outline by adding details."
    )
)

content_creator.register_function(
    FunctionCallingConfig(
        name="generate_content",
        executor=generate_content,
        description="Generates detailed content based on the refined outline."
    )
)

# Start the workflow
course_outline = curriculum_planner.call("create_course_outline")
refined_outline = subject_matter_expert.call("refine_outline", course_outline)
final_content = content_creator.call("generate_content", refined_outline)

# Output the final course content
print(final_content)