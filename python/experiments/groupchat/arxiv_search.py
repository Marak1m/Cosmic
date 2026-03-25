# filename: arxiv_search.py
import arxiv

def search_arxiv():
    results = arxiv.search(query='gpt-4')
    
    # Print the first paper that contains 'gpt-4' in its title or abstract
    for result in results:
        if 'gpt-4' in result.title.lower() or 'gpt-4' in result.abstract.lower():
            print(f"Title: {result.title}")
            print(f"URL: {result.url}")
            return
            
    print("No papers found on arXiv about GPT-4.")
    
search_arxiv()