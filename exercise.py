from selenium import webdriver
from bs4 import BeautifulSoup
import requests
import re


def fetch_list(names):
    driver = webdriver.Chrome(executable_path='/usr/local/bin/chromedriver')
    scroll_count = 250
    driver.get("https://soundcloud.com/search/people?q=" + names[0])
    for m in range(0, scroll_count):
        # if m % 10 == 0:
        #     number = (int(m) / int(scroll_count))*100
        #     print("--- scrolling x " + str(number) + '% ---')
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")

    html = driver.page_source
    soup = BeautifulSoup(html, 'lxml')
    queue_load = []
    for link in soup.findAll('a', {'class': "sc-link-dark"}):
        queue_load.append("https://soundcloud.com" + link['href'])
    driver.close()
    queue_load = queue_load[11:]
    print("Number of artists to scrape through: " + str(len(queue_load)))
    print("\n--- Done scraping ---")
    return queue_load



def list_scrape(queue):
    link = []
    name = []
    email = []
    email_csv = []
    j = 0
    for i in queue:
        j += 1
        print("scraping: " + i + " " + str(j) + "/" + str(len(queue)))
        data_instance = requests.get(i)
        data_instance_text = data_instance.text
        data = BeautifulSoup(data_instance_text, "lxml")
        link_scraped = add_link(data)
        name_scraped = add_name(data)
        emails_scraped = add_sc_email(data)
        link.append(link_scraped)
        name.append(name_scraped)
        email.append(emails_scraped)
        for i in emails_scraped:
            email_csv.append(i)
    return link, name, email, email_csv


def add_link(soup):
    link_list = []
    hrefs = soup.findAll('a', attrs={'itemprop': 'url'}, href=True)
    try:
        href = hrefs[0]
    except IndexError:
        print("Error with href not loading")
        href = ['"link_not_found"', '"support"']
    hrefre = r'"(.*?)"'
    link_snippet = re.findall(hrefre, str(href))
    link_full = "https://soundcloud.com" + link_snippet[0]
    link_list.append(link_full)
    return link_list


def add_name(soup):
    new_list = []
    name = soup.title.text
    new_name = name.replace(" | Free Listening on SoundCloud", "")
    new_list.append(new_name)
    return new_list


def add_sc_email(soup):
    new = soup.find('p', attrs={'itemprop': 'description'})
    email_regex = r"[a-zA-Z0-9-_.]+@[a-zA-Z0-9-_.]+"
    email_re = set(re.findall(email_regex, str(new)))
    return email_re
